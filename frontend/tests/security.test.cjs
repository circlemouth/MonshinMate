// Offline regression tests: use the already-installed TypeScript compiler, no server or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');

test('nginx login navigation is SPA-only for GET/HEAD while authentication APIs stay proxied', () => {
  const config = fs.readFileSync(path.join(root, '../nginx.conf.template'), 'utf8');
  const exact = config.split('location = /admin/login {')[1]?.split('location /admin/login {')[0];
  assert.ok(exact, 'exact login route precedes the child API prefix');
  assert.match(exact, /if \(\$request_method ~ \^\(GET\|HEAD\)\$\) \{\s*rewrite \^ \/index\.html last;\s*\}/);
  assert.match(exact, /proxy_pass \$\{BACKEND_ORIGIN\};/);
  assert.doesNotMatch(exact, /add_header|return 200|proxy_method|Access-Control-Allow/);
  const child = config.split('location /admin/login {')[1]?.split('location /admin/totp {')[0];
  assert.match(child, /proxy_pass \$\{BACKEND_ORIGIN\};/);
  assert.doesNotMatch(child, /try_files|rewrite|return 200/);
  for (const header of ['Cache-Control "no-store"', 'X-Content-Type-Options "nosniff"', 'X-Frame-Options "DENY"']) {
    assert.ok(config.includes(`add_header ${header} always;`));
  }
});

function harness() {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const window = new EventTarget();
  Object.assign(window, { location: { origin: 'https://test.invalid' }, setTimeout: fn => { fn(); return 1; }, alert: () => {} });
  const context = vm.createContext({ window, sessionStorage: storage, Headers, Request, Response, URL, Event,
    AbortController, DOMException, crypto: webcrypto, Date: Clock, TypeError, Error, console,
    fetch: () => { throw new Error('Unexpected fetch: external network is forbidden'); } });
  const cache = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative.endsWith('.ts') ? relative : `${relative}.ts`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const source = fs.readFileSync(filename, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} }; cache.set(filename, module);
    const run = vm.runInContext(`(function(require,module,exports){${code}\n})`, context);
    run(specifier => load(path.relative(root, path.resolve(path.dirname(filename), specifier))), module, module.exports);
    return module.exports;
  }
  return { load, context, storage, window, advance: delta => { now += delta; } };
}
function session(h, id = 'current', token = 'patient-test-token') {
  const data = { id, session_token: token, expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
  h.load('utils/patientSession').storePatientSession(data);
  h.storage.setItem('visit_type', 'initial');
  return data;
}
function json(data, status = 200) { return new Response(JSON.stringify(data), { status }); }

// Administrative authentication and downloads.
test('admin requests carry bearer headers, not URL tokens; cross-origin requests are refused', async () => {
  const h = harness(), api = h.load('utils/adminApi');
  api.acceptAdminToken({ access_token: 'admin-test-token' });
  h.context.fetch = async (url, init) => {
    assert.equal(url, '/admin/sessions');
    assert.equal(init.headers.get('Authorization'), 'Bearer admin-test-token');
    assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    return json([]);
  };
  await api.adminFetch('/admin/sessions');
  await assert.rejects(api.adminFetch('https://other.invalid/admin'), /同一オリジン/);
});
test('401 clears stored authentication and broadcasts React auth invalidation', async () => {
  const h = harness(), api = h.load('utils/adminApi');
  api.acceptAdminToken({ access_token: 'admin-test-token' });
  let invalidations = 0;
  h.window.addEventListener(api.ADMIN_AUTH_CHANGED, () => invalidations++);
  h.context.fetch = async () => new Response('', { status: 401 });
  await api.adminFetch('/admin/sessions');
  assert.equal(h.storage.getItem('adminAccessToken'), null);
  assert.equal(h.storage.getItem('adminLoggedIn'), null);
  assert.equal(invalidations, 1);
});
test('an older 401 cannot log out a newer authenticated session', async () => {
  const h = harness(), api = h.load('utils/adminApi');
  api.acceptAdminToken({ access_token: 'old' });
  let resolve;
  h.context.fetch = () => new Promise(done => { resolve = done; });
  const pending = api.adminFetch('/admin/sessions');
  api.acceptAdminToken({ access_token: 'new' });
  resolve(new Response('', { status: 401 })); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.storage.getItem('adminAccessToken'), 'new');
});
test('enrollment bearer is not overwritten by an existing admin bearer', async () => {
  const h = harness(), api = h.load('utils/adminApi');
  api.acceptAdminToken({ access_token: 'admin' });
  h.context.fetch = async (_, init) => {
    assert.equal(init.headers.get('Authorization'), 'Bearer enrollment');
    assert.equal(init.headers.get('X-Admin-Reauth'), 'proof');
    return json({});
  };
  await api.adminJson('/admin/totp/setup', {}, { Authorization: 'Bearer enrollment', 'X-Admin-Reauth': 'proof' });
  assert.throws(() => api.acceptAdminToken({}), /トークン/);
});
test('downloads fetch an authenticated Blob and revoke their temporary URL', async () => {
  const h = harness(), api = h.load('utils/adminApi');
  api.acceptAdminToken({ access_token: 'download-token' });
  let clicked = false, removed = false, revoked = false;
  const link = { click() { clicked = true; }, remove() { removed = true; } };
  h.context.document = { createElement: () => link, body: { appendChild: () => {} } };
  class TestURL extends URL {}
  TestURL.createObjectURL = () => 'blob:test';
  TestURL.revokeObjectURL = url => { assert.equal(url, 'blob:test'); revoked = true; };
  h.context.URL = TestURL;
  h.context.fetch = async (_, init) => {
    assert.equal(init.headers.get('Authorization'), 'Bearer download-token');
    return new Response('pdf data', { headers: { 'Content-Disposition': 'attachment; filename="result.pdf"' } });
  };
  await api.adminDownload('/admin/sessions/current/download/pdf');
  assert.equal(link.href, 'blob:test'); assert.equal(link.download, 'result.pdf');
  assert.ok(clicked && removed && revoked);
});

test('logout aborts pending admin fetches and rejects late successful responses even with the same replacement token', async () => {
  const h = harness(), api = h.load('utils/adminApi'); api.acceptAdminToken({ access_token: 'same' });
  let resolve, signal;
  h.context.fetch = (_, init) => { signal = init.signal; return new Promise(done => { resolve = done; }); };
  const pending = api.adminFetch('/admin/sessions');
  api.clearAdminSession(); assert.equal(signal.aborted, true);
  api.acceptAdminToken({ access_token: 'same' }); resolve(json({ secret: 'mock' }));
  await assert.rejects(pending, { name: 'AbortError' });
  h.context.fetch = async () => json({ secret: 'mock' });
  const clone = (await api.adminFetch('/admin/sessions')).clone();
  api.clearAdminSession();
  await assert.rejects(clone.json(), { name: 'AbortError' });
});
test('logout after headers rejects delayed JSON and suppresses delayed Blob download clicks and alerts', async () => {
  for (const kind of ['json', 'blob']) {
    const h = harness(), api = h.load('utils/adminApi'); api.acceptAdminToken({ access_token: 'admin' });
    let resolveBody, signalStarted, clicks = 0, alerts = 0;
    const started = new Promise(done => { signalStarted = done; });
    h.window.alert = () => alerts++;
    h.context.document = { createElement: () => ({ click: () => clicks++, remove() {} }), body: { appendChild() {} } };
    h.context.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), [kind]: () => { signalStarted(); return new Promise(done => { resolveBody = done; }); } });
    const pending = kind === 'json' ? api.adminJson('/admin/sessions', {}) : api.adminDownload('/admin/sessions/current/download/pdf');
    await started; api.clearAdminSession(); resolveBody(kind === 'json' ? { secret: 'mock' } : new Blob(['mock']));
    if (kind === 'json') await assert.rejects(pending, { name: 'AbortError' }); else await pending;
    assert.equal(clicks, 0); assert.equal(alerts, 0);
  }
});
test('cancelled login, enrollment and reauth view requests cannot apply late successful authentication', async () => {
  for (const endpoint of ['/admin/login', '/admin/bootstrap', '/admin/recovery', '/admin/totp/verify', '/admin/reauth']) {
    const h = harness(), api = h.load('utils/adminApi'), scope = h.load('utils/requestScope').createRequestScope();
    let resolve, navigation = 0;
    h.context.fetch = () => new Promise(done => { resolve = done; });
    const request = scope.start();
    const pending = (async () => { const data = await api.adminJson(endpoint, {}, {}, request.signal); request.assertCurrent(); api.acceptAdminToken(data); navigation++; })();
    scope.cancel(); resolve(json({ access_token: 'late-token' }));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(h.storage.getItem('adminAccessToken'), null); assert.equal(navigation, 0);
    const replacement = scope.start(); assert.equal(replacement.current(), true); assert.equal(request.current(), false);
  }
});
test('auth views cancel on unmount and chat remains an authenticated admin route', () => {
  const hook = fs.readFileSync(path.join(root, 'hooks/useRequestScope.ts'), 'utf8');
  assert.match(hook, /useLayoutEffect\(\(\) => \(\) => scope.current.cancel\(\)/);
  for (const file of ['pages/AdminLogin.tsx', 'components/AdminEnrollment.tsx', 'pages/AdminSecurity.tsx']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /useRequestScope\(\)/); assert.match(source, /request.assertCurrent\(\);\s*acceptAdminToken\(data\)/);
  }
  const app = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
  assert.match(app, /isLoginOpen && <AdminLogin/);
  assert.match(app, /path="\/chat" element=\{isAuthenticated \? <LLMChat/);
  assert.match(app, /!location.pathname.startsWith\('\/admin'\) && location.pathname !== '\/chat'/);
  const detail = fs.readFileSync(path.join(root, 'pages/AdminSessionDetail.tsx'), 'utf8');
  assert.match(detail, /catch \(error\) \{\s*if \(controller.signal.aborted \|\| !snapshot.current\(\)\) return/);
});

// Lightweight component harness: execute event handlers and inspect rendered fields without a browser.
function authView(file, options = {}) {
  const h = harness(), api = h.load('utils/adminApi');
  const state = options.state || [], calls = [], navigation = [];
  let cursor = 0;
  const scope = h.load('utils/requestScope').createRequestScope();
  const jsx = (type, props) => ({ type, props: props || {} });
  const modules = {
    react: { useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; }, useEffect: () => {} },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@chakra-ui/react': new Proxy({}, { get: (_, key) => key }),
    'react-router-dom': { useNavigate: () => (...args) => navigation.push(args), Link: 'Link' },
    '../contexts/AuthContext': { useAuth: () => ({ isTotpEnabled: false, mfaRequired: false, checkAuthStatus: async () => {}, ...options.auth }) },
    '../hooks/useRequestScope': { useRequestScope: () => scope },
    '../utils/adminApi': api,
    '../components/AdminEnrollment': { default: 'AdminEnrollment' },
  };
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
  h.context.TextEncoder = TextEncoder;
  h.context.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return json(options.response?.(url) || { status: 'ok', access_token: 'synthetic-access', expires_in: 900 }); };
  const module = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${code}\n})`, h.context)(name => { if (!(name in modules)) throw new Error(`Unexpected module: ${name}`); return modules[name]; }, module, module.exports);
  let tree;
  const render = () => { cursor = 0; tree = module.exports.default(options.props || {}); return tree; };
  const nodes = () => { const result = []; const walk = value => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') { result.push(value); walk(value.props?.children); } }; walk(tree); return result; };
  render();
  return { ...h, api, scope, state, calls, navigation, render, nodes };
}
test('password-only login accepts access without a code field or enrollment screen', async () => {
  const view = authView('pages/AdminLogin.tsx', { state: ['current-synthetic-password'] });
  assert.equal(view.nodes().filter(node => node.type === 'Input').length, 1);
  assert.equal(view.nodes().find(node => node.type === 'Input').props.type, 'password');
  view.nodes().find(node => node.props.as === 'form').props.onSubmit({ preventDefault() {} });
  // The form handler intentionally starts its asynchronous submit without returning it.
  for (let i = 0; i < 20 && !view.navigation.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.storage.getItem('adminAccessToken'), 'synthetic-access');
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0].url, '/admin/login');
  assert.equal(view.calls[0].body.password, 'current-synthetic-password');
  assert.equal(view.state[2], ''); assert.equal(view.navigation[0][0], '/admin/main');
});
test('MFA-enabled login still requires the server challenge and never silently downgrades', async () => {
  const view = authView('pages/AdminLogin.tsx', { state: ['current-synthetic-password'], response: url => url === '/admin/login' ? { status: 'totp_required', challenge_token: 'synthetic-challenge' } : { status: 'ok', access_token: 'synthetic-access', expires_in: 900 } });
  view.nodes().find(node => node.props.as === 'form').props.onSubmit({ preventDefault() {} });
  for (let i = 0; i < 20 && !view.state[1]; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.storage.getItem('adminAccessToken'), null); assert.equal(view.navigation.length, 0);
  view.render();
  const code = view.nodes().find(node => node.type === 'Input');
  assert.equal(code.props.autoComplete, 'one-time-code');
  code.props.onChange({ target: { value: '123456' } }); view.render();
  view.nodes().find(node => node.props.as === 'form').props.onSubmit({ preventDefault() {} });
  for (let i = 0; i < 20 && !view.navigation.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.calls[1].url, '/admin/login/totp');
  assert.equal(view.calls[1].body.challenge_token, 'synthetic-challenge');
  assert.equal(view.calls[1].body.totp_code, '123456');
  assert.equal(view.storage.getItem('adminAccessToken'), 'synthetic-access');
});
test('bootstrap and recovery accept direct access or continue mandatory enrollment', async () => {
  for (const mode of ['bootstrap', 'recovery']) for (const enrollment of [false, true]) {
    const view = authView('components/AdminEnrollment.tsx', {
      props: { mode }, state: ['synthetic-credential', 'synthetic-password', 'synthetic-password'],
      response: url => url.endsWith('/setup') ? { enrollment_id: 'pending', qr_code_data_url: 'data:image/png;base64,test' }
        : enrollment ? { status: 'enrollment_required', enrollment_token: 'limited-token' } : { status: 'ok', access_token: 'synthetic-access', expires_in: 900 },
    });
    await view.nodes().find(node => node.type === 'Button').props.onClick();
    assert.equal(view.calls[0].url, `/admin/${mode}`);
    assert.equal(view.calls.length, enrollment ? 2 : 1);
    assert.equal(view.storage.getItem('adminAccessToken'), enrollment ? null : 'synthetic-access');
    assert.equal(view.navigation.length, enrollment ? 0 : 1);
    if (enrollment) assert.equal(view.calls[1].headers.get('Authorization'), 'Bearer limited-token');
  }
});
test('malformed enrollment response never authenticates or starts setup', async () => {
  for (const response of [{ status: 'ok' }, { status: 'unknown', access_token: 'bad' }, { status: 'enrollment_required' }]) {
    const view = authView('components/AdminEnrollment.tsx', { state: ['credential', 'synthetic-password', 'synthetic-password'], props: { mode: 'recovery' }, response: () => response });
    await view.nodes().find(node => node.type === 'Button').props.onClick();
    assert.equal(view.storage.getItem('adminAccessToken'), null); assert.equal(view.calls.length, 1); assert.equal(view.navigation.length, 0);
  }
});
test('security reauth hides OTP only when account MFA is disabled, independent of optional policy', async () => {
  for (const enabled of [false, true]) {
    const view = authView('pages/AdminSecurity.tsx', { auth: { isTotpEnabled: enabled, mfaRequired: false }, state: ['synthetic-password', '123456', 'replacement-password', 'replacement-password'], response: url => url.endsWith('/reauth') ? { reauth_token: 'synthetic-reauth' } : { status: 'ok' } });
    assert.equal(view.nodes().filter(node => node.type === 'Input' && node.props.autoComplete === 'one-time-code').length, enabled ? 1 : 0);
    await view.nodes().find(node => node.type === 'Button' && node.props.children === 'パスワードを変更').props.onClick();
    assert.equal(view.calls[0].url, '/admin/reauth');
    assert.equal(view.calls[0].body.totp_code, enabled ? '123456' : undefined);
    assert.equal(view.calls[1].headers.get('X-Admin-Reauth'), 'synthetic-reauth');
    assert.equal(view.navigation[0][0], '/admin/login');
  }
});

// Session identity, stale requests, retries and completion acknowledgements.
test('patient calls require current ID/token, including after expiry', async () => {
  const h = harness(), api = h.load('utils/patientSession'); session(h);
  h.context.fetch = async (url, init) => {
    assert.equal(url, '/sessions/current/answers');
    assert.equal(init.headers.get('Authorization'), 'Bearer patient-test-token');
    return json({});
  };
  await api.patientFetch('/sessions/current/answers');
  await assert.rejects(api.patientFetch('/sessions/other/answers'));
  await assert.rejects(api.patientFetch('https://other.invalid/sessions/current/answers'));
  await assert.rejects(api.patientFetch('/sessions/current/answers?token=bad'));
  h.advance(24 * 60 * 60_000 + 60_000);
  await assert.rejects(api.patientFetch('/sessions/current/answers'));
});
test('cleanup removes all patient storage, invalidates memory epoch and aborts requests', async () => {
  const h = harness(), api = h.load('utils/patientSession'); session(h);
  for (const key of api.PATIENT_STORAGE_KEYS) h.storage.setItem(key, 'mock-patient-data');
  h.storage.setItem('adminAccessToken', 'unrelated-admin');
  const epoch = api.patientGeneration(), signal = api.patientSignal();
  let events = 0; h.window.addEventListener(api.PATIENT_CLEARED, () => events++);
  api.clearPatientSession();
  for (const key of api.PATIENT_STORAGE_KEYS) assert.equal(h.storage.getItem(key), null, key);
  assert.ok(signal.aborted); assert.equal(api.isPatientGeneration(epoch), false);
  assert.equal(events, 1); assert.equal(h.storage.getItem('adminAccessToken'), 'unrelated-admin');
});
test('a late response cannot return data after another patient starts', async () => {
  const h = harness(), api = h.load('utils/patientSession'); session(h);
  let resolve;
  h.context.fetch = () => new Promise(done => { resolve = done; });
  const pending = api.patientJson('/sessions/current/llm-questions', { method: 'POST' });
  api.clearPatientSession(); session(h, 'next', 'new-token');
  resolve(json({ questions: ['old patient'] }));
  await assert.rejects(pending, /切り替わりました/);
});
test('late JSON parsing is also rejected after cleanup', async () => {
  const h = harness(), api = h.load('utils/patientSession'); session(h);
  let parsed;
  h.context.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(done => { parsed = done; }) });
  const pending = api.patientJson('/sessions/current/llm-questions');
  await new Promise(done => setImmediate(done));
  api.clearPatientSession(); parsed({ questions: [] });
  await assert.rejects(pending, /切り替わりました/);
});
test('retries are bounded to current ID AND token, with a 30 minute TTL', async () => {
  const h = harness(), queue = h.load('retryQueue'); session(h);
  h.context.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(queue.postWithRetry('/sessions/current/answers', { answers: { mock: 'value' } }));
  assert.equal(queue.hasPendingRetries(), true);
  h.storage.setItem('session_token', 'different-token');
  assert.equal(queue.hasPendingRetries(), false);
  session(h);
  await assert.rejects(queue.postWithRetry('/sessions/current/answers', { answers: {} }));
  h.advance(queue.QUEUE_TTL_MS + 1);
  assert.equal(queue.hasPendingRetries(), false);
  let calls = 0; h.context.fetch = async () => { calls++; return json({}); };
  await queue.flushQueue(true); assert.equal(calls, 0);
});
test('retry processing uses bearer and deletes successfully sent items', async () => {
  const h = harness(), queue = h.load('retryQueue'); session(h);
  h.context.fetch = async () => json({}, 503);
  await assert.rejects(queue.postWithRetry('/sessions/current/answers', { answers: { mock: 'safe' } }));
  h.context.fetch = async (_, init) => {
    assert.equal(init.headers.get('Authorization'), 'Bearer patient-test-token');
    assert.equal(JSON.parse(init.body).answers.mock, 'safe');
    return json({});
  };
  await queue.flushQueue(true);
  assert.equal(h.storage.getItem('retry_queue'), null);
});
test('clearing a patient during retry cannot recreate the old queue', async () => {
  const h = harness(), queue = h.load('retryQueue'), api = h.load('utils/patientSession'); session(h);
  h.context.fetch = async () => json({}, 503);
  await assert.rejects(queue.postWithRetry('/sessions/current/answers', { answers: {} }));
  let resolve;
  h.context.fetch = () => new Promise(done => { resolve = done; });
  const flushing = queue.flushQueue(true);
  api.clearPatientSession(); session(h, 'next');
  resolve(json({}, 503)); await flushing;
  assert.equal(h.storage.getItem('retry_queue'), null);
});
test('a failed queued answer blocks finalization until explicitly resubmitted', async () => {
  const h = harness(), queue = h.load('retryQueue'), { finalizePatient } = h.load('utils/finalizePatient'); session(h);
  h.context.fetch = async () => json({}, 503);
  await assert.rejects(queue.postWithRetry('/sessions/current/answers', { answers: {} }));
  let finalizations = 0;
  h.context.fetch = async url => { if (url.endsWith('/finalize')) finalizations++; return json({}, 409); };
  await assert.rejects(finalizePatient('current'));
  assert.equal(finalizations, 0); assert.equal(queue.hasPendingRetries(), true);
  h.context.fetch = async () => json({});
  await queue.postWithRetry('/sessions/current/answers', { answers: {} });
  assert.equal(queue.hasPendingRetries(), false);
});
test('terminal failures and finalization never enter the answer retry queue', async () => {
  const h = harness(), queue = h.load('retryQueue'); session(h);
  h.context.fetch = async () => json({}, 409);
  await assert.rejects(queue.postWithRetry('/sessions/current/answers', { answers: {} }), /409/);
  await assert.rejects(queue.postWithRetry('/sessions/current/finalize', {}));
  assert.equal(h.storage.getItem('retry_queue'), null);
});
test('failed or invalid completion acknowledgements retain patient answers and token', async () => {
  const h = harness(), { finalizePatient } = h.load('utils/finalizePatient'); session(h);
  h.storage.setItem('answers', '{"mock":"answer"}');
  for (const response of [() => json({}, 500), () => json({ status: 'finalized', id: 'different', finalized_at: 'now' }), () => json({ id: 'current', summary: 'old contract' })]) {
    h.context.fetch = async () => response();
    await assert.rejects(finalizePatient('current'));
    assert.equal(h.storage.getItem('answers'), '{"mock":"answer"}');
    assert.equal(h.storage.getItem('session_token'), 'patient-test-token');
  }
});
test('acknowledged completion clears every patient field and retry, only after receipt', async () => {
  const h = harness(), api = h.load('utils/patientSession'), { finalizePatient } = h.load('utils/finalizePatient'); session(h);
  h.storage.setItem('patient_name', 'MOCK'); h.storage.setItem('answers', '{"mock":"answer"}');
  h.context.fetch = async (url, init) => {
    assert.equal(url, '/sessions/current/finalize');
    assert.equal(init.headers.get('Authorization'), 'Bearer patient-test-token');
    assert.equal(h.storage.getItem('patient_name'), 'MOCK');
    return json({ status: 'finalized', id: 'current', finalized_at: new Date().toISOString() });
  };
  await finalizePatient('current');
  for (const key of api.PATIENT_STORAGE_KEYS) assert.equal(h.storage.getItem(key), null, key);
});
test('stale, unbound legacy queue entries cannot replay', async () => {
  const h = harness(), queue = h.load('retryQueue'); session(h);
  h.storage.setItem('retry_queue', JSON.stringify([{ url: '/sessions/current/answers', options: { body: 'legacy' }, attempts: 0 }]));
  await queue.flushQueue(true);
  assert.equal(h.storage.getItem('retry_queue'), null);
});

test('idle timeout warns at 15 minutes and expires one minute later without timer drift', () => {
  const h = harness(), api = h.load('utils/patientSession');
  h.storage.setItem('patient_last_activity', String(vm.runInContext('Date.now()', h.context)));
  assert.equal(api.patientIdleState(), 'active');
  h.advance(api.IDLE_WARNING_MS - 1); assert.equal(api.patientIdleState(), 'active');
  h.advance(1); assert.equal(api.patientIdleState(), 'warning');
  h.advance(59_999); assert.equal(api.patientIdleState(), 'warning');
  h.advance(1); assert.equal(api.patientIdleState(), 'expired');
  // A suspended tab receives the same decision based on wall-clock time, not interval counts.
  h.advance(60 * 60_000); assert.equal(api.patientIdleState(), 'expired');
});
test('back/forward and resumed routes cannot render old patient forms after cleanup', () => {
  const h = harness(), api = h.load('utils/patientSession');
  assert.equal(api.canAccessPatientRoute(true), false);
  h.storage.setItem('visit_type', 'initial');
  assert.equal(api.canAccessPatientRoute(true), true);
  assert.equal(api.canAccessPatientRoute(), false);
  session(h); assert.equal(api.canAccessPatientRoute(), true);
  api.clearPatientSession();
  assert.equal(api.canAccessPatientRoute(true), false);
  assert.equal(api.canAccessPatientRoute(), false);
});

// Source-level guards complement helper execution without pretending to be browser E2E tests.
test('auth forms use challenge/enrollment/reauth contracts, not retired reset endpoints', () => {
  const login = fs.readFileSync(path.join(root, 'pages/AdminLogin.tsx'), 'utf8');
  assert.match(login, /challenge_token: challenge, totp_code: code/);
  assert.match(login, /data.status === 'enrollment_required'/);
  const enrollment = fs.readFileSync(path.join(root, 'components/AdminEnrollment.tsx'), 'utf8');
  assert.match(enrollment, /enrollment_id: enrollmentId, totp_code: code/);
  assert.match(enrollment, /Authorization: `Bearer \$\{enrollmentToken\}`/);
  const security = fs.readFileSync(path.join(root, 'pages/AdminSecurity.tsx'), 'utf8');
  assert.match(security, /X-Admin-Reauth/);
  for (const file of ['AdminLogin', 'AdminInitialPassword', 'AdminPasswordReset', 'AdminTotpSetup', 'AdminSecurity']) {
    const source = fs.readFileSync(path.join(root, `pages/${file}.tsx`), 'utf8');
    assert.doesNotMatch(source, /sessionStorage\.setItem\([^\n]*(challenge|enrollment|reauth)/);
    assert.doesNotMatch(source, /['"]\/admin\/password\/reset\/(request|confirm|emergency)['"]/);
  }
});
test('patient completion uses replace navigation only after acknowledged finalization', () => {
  for (const file of ['QuestionnaireForm', 'Questions', 'LlmWait']) {
    const source = fs.readFileSync(path.join(root, `pages/${file}.tsx`), 'utf8');
    assert.match(source, /await finalizePatient\(sessionId\);\s*navigate\('\/done', \{ replace: true \}\)/);
    assert.doesNotMatch(source, /setItem\('summary'/);
  }
  const safety = fs.readFileSync(path.join(root, 'components/PatientSafety.tsx'), 'utf8');
  assert.match(safety, /patientIdleState/);
  assert.match(safety, /pagehide/); assert.match(safety, /event.persisted/);
  assert.match(safety, /PATIENT_CLEARED/);
});
test('admin pages never issue unauthenticated API fetches or window.open downloads', () => {
  for (const name of fs.readdirSync(path.join(root, 'pages')).filter(name => name.startsWith('Admin') && name.endsWith('.tsx'))) {
    const source = fs.readFileSync(path.join(root, 'pages', name), 'utf8');
    if (!['AdminLicense.tsx', 'AdminManual.tsx'].includes(name)) assert.doesNotMatch(source, /\bfetch\(/, name);
    assert.doesNotMatch(source, /window\.open/, name);
    assert.doesNotMatch(source, /(?:href|src)=\{[^}]*\/admin\/sessions/, name);
  }
});
