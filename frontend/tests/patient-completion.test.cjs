// Offline regressions: real TS/TSX modules, synthetic values, and no server/network.
// Hooks/effects are committed explicitly; Navigate is inspected, not scheduled by a real Router.
// This deliberately keeps old Safety callbacks alive across cleanup, but is not browser E2E.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const START = Date.UTC(2034, 0, 1);
const PATIENT_PATHS = ['/basic-info', '/questionnaire', '/questions', '/llm-wait'];

function trackedTarget() {
  const target = new EventTarget(), listeners = new Map();
  const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
  target.addEventListener = (name, callback, options) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback); add(name, callback, options);
  };
  target.removeEventListener = (name, callback, options) => {
    listeners.get(name)?.delete(callback); remove(name, callback, options);
  };
  target.handlers = name => [...(listeners.get(name) || [])];
  return target;
}

function harness(pathname = '/questionnaire') {
  let now = START, timerId = 0, currentView;
  const values = new Map(), writes = [], intervals = new Map(), navigation = [], notifications = [];
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push({ key, value: String(value) }); values.set(key, String(value)); },
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  class Clock extends Date { static now() { return now; } }
  const window = trackedTarget(), document = trackedTarget();
  const location = { pathname };
  const navigate = (...args) => navigation.push(args);
  let closedNotifications = 0;
  const notify = { closeAll: () => closedNotifications++, notify: value => notifications.push(value) };
  const setInterval = (callback, ms) => { const id = ++timerId; intervals.set(id, { callback, ms }); return id; };
  const clearInterval = id => intervals.delete(id);
  Object.assign(window, { location: { origin: 'https://patient-test.invalid' }, setInterval, clearInterval });
  document.visibilityState = 'visible';
  const context = vm.createContext({ window, document, sessionStorage: storage, Headers, Request, Response,
    URL, Event, AbortController, DOMException, crypto: webcrypto, Date: Clock, TypeError, Error, console,
    setInterval, clearInterval,
    fetch: () => { throw new Error('Unexpected fetch: external network is forbidden'); } });
  const slot = () => {
    assert.ok(currentView, 'hooks must run inside an explicit component render');
    const view = currentView, index = view.cursor++;
    if (!view.hooks[index]) view.hooks[index] = {};
    return [view, view.hooks[index]];
  };
  const changed = (before, after) => !before || !after || before.length !== after.length || before.some((value, i) => !Object.is(value, after[i]));
  const jsx = (type, props) => ({ type, props: props || {} });
  const mocks = new Map(Object.entries({
    react: {
      useState: initial => {
        const [view, state] = slot();
        if (!('value' in state)) {
          state.value = typeof initial === 'function' ? initial() : initial;
          state.set = value => { state.value = typeof value === 'function' ? value(state.value) : value; view.updates++; };
        }
        return [state.value, state.set];
      },
      useRef: initial => { const [, state] = slot(); if (!state.ref) state.ref = { current: initial }; return state.ref; },
      useMemo: (compute, deps) => { const [, state] = slot(); if (changed(state.deps, deps)) { state.value = compute(); state.deps = deps; } return state.value; },
      useEffect: (effect, deps) => { const [view, state] = slot(); if (changed(state.deps, deps)) view.pending.push({ state, effect, deps }); },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@chakra-ui/react': new Proxy({}, { get: (_, name) => name }),
    'react-router-dom': { Navigate: 'Navigate', useNavigate: () => navigate, useLocation: () => location },
    '../contexts/NotificationContext': { useNotify: () => notify },
  }));
  const allowed = new Set(['utils/patientSession.ts', 'utils/finalizePatient.ts', 'retryQueue.ts',
    'components/PatientSafety.tsx', 'pages/Questions.tsx', 'pages/LlmWait.tsx']);
  const cache = new Map();
  function load(relative) {
    if (!/\.tsx?$/.test(relative)) relative += '.ts';
    const filename = path.resolve(root, relative), key = path.relative(root, filename);
    assert.ok(allowed.has(key), `Unexpected source module: ${key}`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const source = fs.readFileSync(filename, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} }; cache.set(filename, module);
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context)(specifier => {
      if (mocks.has(specifier)) return mocks.get(specifier);
      assert.ok(specifier.startsWith('.'), `Unexpected external module: ${specifier}`);
      return load(path.relative(root, path.resolve(path.dirname(filename), specifier)));
    }, module, module.exports);
    return module.exports;
  }
  function mount(file = 'components/PatientSafety.tsx', name = 'default', props = {}, commit = true) {
    const Component = load(file)[name];
    const view = { hooks: [], pending: [], cursor: 0, updates: 0, tree: undefined };
    view.render = () => {
      view.cursor = 0; view.pending = []; currentView = view;
      try { view.tree = Component(props); } finally { currentView = undefined; }
      return view.tree;
    };
    view.commit = () => {
      for (const { state, effect, deps } of view.pending.splice(0)) {
        state.cleanup?.(); state.deps = deps; state.cleanup = effect();
      }
    };
    view.unmount = () => { for (const state of view.hooks) state.cleanup?.(); };
    view.nodes = () => {
      const result = [];
      const walk = node => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') { result.push(node); walk(node.props?.children); }
      };
      walk(view.tree); return result;
    };
    view.render(); if (commit) view.commit();
    return view;
  }
  return { load, mount, context, storage, values, writes, window, document, intervals, navigation, notifications,
    now: () => now, advance: delta => { now += delta; }, mock: (name, exports) => mocks.set(name, exports),
    get closedNotifications() { return closedNotifications; } };
}

function session(h, id = 'synthetic-current', token = 'synthetic-patient-token') {
  const data = { id, session_token: token, expires_at: new Date(h.now() + 24 * 60 * 60_000).toISOString() };
  h.load('utils/patientSession').storePatientSession(data);
  h.storage.setItem('visit_type', 'initial');
  h.storage.setItem('answers', '{"synthetic":"answer"}');
  return h.load('utils/patientSession').getPatientSession();
}
function receipt(expected) { return { id: expected.id, status: 'finalized', finalized_at: new Date(START).toISOString() }; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function wiped(h, api) { for (const key of api.PATIENT_STORAGE_KEYS) assert.equal(h.storage.getItem(key), null, key); }
function redirect(view, to) { assert.equal(view.tree.type, 'Navigate'); assert.equal(view.tree.props.to, to); assert.equal(view.tree.props.replace, true); }
function button(view, label) {
  const node = view.nodes().find(node => node.type === 'Button' && node.props.children === label);
  assert.ok(node, `Missing real component button: ${label}`); return node.props.onClick;
}
function topNavigation(h) { assert.equal(h.navigation.length, 1); assert.equal(h.navigation[0][0], '/'); assert.equal(h.navigation[0][1].replace, true); }
function transition(name, persisted) { const event = new Event(name); Object.defineProperty(event, 'persisted', { value: persisted }); return event; }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('missing, mismatched and unfinalized receipts never mark completion or alter patient state', () => {
  const h = harness(), api = h.load('utils/patientSession'), expected = session(h);
  assert.equal(api.hasAcknowledgedCompletion(), false);
  const before = [...h.values], epoch = api.patientGeneration(), signal = api.patientSignal();
  let cleared = 0; h.window.addEventListener(api.PATIENT_CLEARED, () => cleared++);
  for (const invalid of [{}, { ...receipt(expected), id: 'synthetic-other' },
    { ...receipt(expected), status: 'pending' }, { ...receipt(expected), finalized_at: '' },
    { id: expected.id, status: 'finalized' }, { status: 'finalized', finalized_at: receipt(expected).finalized_at }]) {
    assert.throws(() => api.acknowledgeFinalization(invalid, expected), /完了確認/);
    assert.equal(api.hasAcknowledgedCompletion(), false); assert.deepEqual([...h.values], before);
    assert.equal(api.patientGeneration(), epoch); assert.equal(signal.aborted, false); assert.equal(cleared, 0);
  }
});

test('network, HTTP, malformed JSON and invalid successful responses never acknowledge completion', async () => {
  const responses = [undefined, () => json({}, 401), () => json({}, 409), () => json({}, 503),
    () => new Response('synthetic-invalid-json'), () => json({ status: 'finalized', id: 'synthetic-other', finalized_at: 'synthetic' }),
    () => json({ id: 'synthetic-current', status: 'finalized' })];
  for (const response of responses) {
    const h = harness(), api = h.load('utils/patientSession'); session(h);
    const { finalizePatient } = h.load('utils/finalizePatient');
    if (response) h.context.fetch = async () => response();
    let cleared = 0; h.window.addEventListener(api.PATIENT_CLEARED, () => cleared++);
    await assert.rejects(finalizePatient('synthetic-current'));
    assert.equal(api.hasAcknowledgedCompletion(), false); assert.equal(cleared, 0);
    assert.equal(h.storage.getItem('answers'), '{"synthetic":"answer"}');
    assert.equal(h.storage.getItem('session_token'), 'synthetic-patient-token');
  }
});

test('a stale expected patient or expired session cannot acknowledge a valid-looking receipt', () => {
  const h = harness(), api = h.load('utils/patientSession'), old = session(h);
  session(h, old.id, 'synthetic-replacement-token');
  assert.throws(() => api.acknowledgeFinalization(receipt(old), old), /完了確認/);
  assert.equal(api.hasAcknowledgedCompletion(), false);
  const current = api.getPatientSession(); h.advance(24 * 60 * 60_000 + 1);
  assert.throws(() => api.acknowledgeFinalization(receipt(current), current), /完了確認/);
  assert.equal(api.hasAcknowledgedCompletion(), false);
});

test('late receipts and late JSON cannot acknowledge after cleanup, even if the same ID/token is reused', async () => {
  for (const stage of ['headers', 'json']) {
    const h = harness(), api = h.load('utils/patientSession'), old = session(h);
    const { finalizePatient } = h.load('utils/finalizePatient');
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    h.context.fetch = stage === 'headers'
      ? () => { started(); return new Promise(resolve => { release = resolve; }); }
      : async () => ({ ok: true, status: 200, json: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const pending = finalizePatient(old.id), rejected = assert.rejects(pending, /切り替わりました/);
    await waiting;
    api.clearPatientSession(); session(h, old.id, old.token);
    h.storage.setItem('answers', '{"synthetic":"next-patient"}');
    const epoch = api.patientGeneration(), signal = api.patientSignal();
    release(stage === 'headers' ? json(receipt(old)) : receipt(old)); await rejected;
    assert.equal(api.hasAcknowledgedCompletion(), false); assert.equal(api.patientGeneration(), epoch);
    assert.equal(signal.aborted, false); assert.equal(h.storage.getItem('answers'), '{"synthetic":"next-patient"}');
  }
});

test('valid acknowledgement publishes its memory-only marker before PATIENT_CLEARED, after wiping and aborting', () => {
  const h = harness(), api = h.load('utils/patientSession'), expected = session(h);
  for (const key of api.PATIENT_STORAGE_KEYS) if (!['session_id', 'session_token', 'session_expires_at'].includes(key)) h.storage.setItem(key, `synthetic-${key}`);
  h.storage.setItem('adminAccessToken', 'synthetic-unrelated-admin');
  const epoch = api.patientGeneration(), signal = api.patientSignal(), observations = [];
  h.window.addEventListener(api.PATIENT_CLEARED, () => observations.push({
    completed: api.hasAcknowledgedCompletion(), generation: api.patientGeneration(), aborted: signal.aborted,
    newSignal: api.patientSignal(), remaining: api.PATIENT_STORAGE_KEYS.filter(key => h.storage.getItem(key) !== null),
  }));
  api.acknowledgeFinalization(receipt(expected), expected);
  assert.equal(observations.length, 1);
  const seen = observations[0];
  assert.equal(seen.completed, true); assert.equal(typeof seen.completed, 'boolean');
  assert.equal(seen.generation, epoch + 1); assert.equal(api.isPatientGeneration(epoch), false);
  assert.equal(seen.aborted, true); assert.notEqual(seen.newSignal, signal); assert.equal(seen.newSignal.aborted, false);
  assert.equal(seen.remaining.length, 0); wiped(h, api);
  assert.deepEqual([...h.values], [['adminAccessToken', 'synthetic-unrelated-admin']], 'no completion marker is persisted');
  assert.equal(Object.hasOwn(api, 'resetPatientSession'), false, 'cleanup reason stays private');
});

test('finalizePatient waits for a successful receipt before acknowledging and clearing', async () => {
  const h = harness(), api = h.load('utils/patientSession'), expected = session(h);
  const { finalizePatient } = h.load('utils/finalizePatient');
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.context.fetch = (url, init) => {
    assert.equal(url, `/sessions/${expected.id}/finalize`); assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('Authorization'), `Bearer ${expected.token}`);
    started(); return new Promise(resolve => { release = resolve; });
  };
  const pending = finalizePatient(expected.id); await waiting;
  assert.equal(api.hasAcknowledgedCompletion(), false); assert.ok(api.getPatientSession());
  release(json(receipt(expected))); await pending;
  assert.equal(api.hasAcknowledgedCompletion(), true); wiped(h, api);
});

test('general clear and a new stored patient reset a previous completion marker', () => {
  for (const action of ['clear', 'store']) {
    const h = harness(), api = h.load('utils/patientSession'), expected = session(h);
    api.acknowledgeFinalization(receipt(expected), expected);
    const epoch = api.patientGeneration(), signal = api.patientSignal(), observed = [];
    h.window.addEventListener(api.PATIENT_CLEARED, () => observed.push(api.hasAcknowledgedCompletion()));
    if (action === 'clear') api.clearPatientSession(); else session(h, 'synthetic-next', 'synthetic-next-token');
    assert.equal(api.hasAcknowledgedCompletion(), false); assert.equal(api.patientGeneration(), epoch + 1);
    assert.equal(signal.aborted, true); assert.equal(api.patientSignal().aborted, false);
    assert.deepEqual(observed, action === 'clear' ? [false] : []);
    if (action === 'clear') wiped(h, api); else assert.equal(api.getPatientSession().id, 'synthetic-next');
  }
});

test('real PatientGuard routes only acknowledged cleanup to /done and refuses it before completion or after resets', () => {
  const h = harness(), api = h.load('utils/patientSession');
  const guarded = h.mount('components/PatientSafety.tsx', 'PatientGuard', { children: 'synthetic-child' });
  const entry = h.mount('components/PatientSafety.tsx', 'PatientGuard', { children: 'synthetic-entry', entry: true });
  redirect(guarded, '/'); redirect(entry, '/');
  h.storage.setItem('visit_type', 'initial');
  entry.render(); assert.equal(entry.tree.props.children, 'synthetic-entry');
  guarded.render(); redirect(guarded, '/');
  let expected = session(h);
  guarded.render(); assert.equal(guarded.tree.props.children, 'synthetic-child');
  api.acknowledgeFinalization(receipt(expected), expected);
  assert.equal(guarded.updates, 1, 'PATIENT_CLEARED invalidates the mounted guard');
  guarded.render(); entry.render(); redirect(guarded, '/done'); redirect(entry, '/done');
  api.clearPatientSession(); guarded.render(); entry.render(); redirect(guarded, '/'); redirect(entry, '/');
  expected = session(h); api.acknowledgeFinalization(receipt(expected), expected);
  api.storePatientSession({ id: 'synthetic-next', session_token: 'synthetic-next-token', expires_at: new Date(h.now() + 60_000).toISOString() });
  guarded.render(); entry.render(); redirect(guarded, '/'); redirect(entry, '/');
  h.storage.setItem('visit_type', 'initial'); guarded.render(); assert.equal(guarded.tree.props.children, 'synthetic-child');
  h.advance(60_001); guarded.render(); redirect(guarded, '/');
});

test('old active Safety timer, visibility, pointer, key and Continue callbacks cannot undo completion or recreate storage', async () => {
  const h = harness(), api = h.load('utils/patientSession'), expected = session(h);
  h.storage.setItem('patient_last_activity', String(h.now() - api.IDLE_WARNING_MS));
  const safety = h.mount(); safety.render(); assert.equal(safety.tree.props.isOpen, true);
  const continueOld = button(safety, '続ける');
  const timerCallbacks = [...h.intervals.values()].map(({ callback }) => callback);
  const visibility = h.document.handlers('visibilitychange'), pointer = h.window.handlers('pointerdown'), key = h.window.handlers('keydown');
  assert.equal(timerCallbacks.length, 2); assert.equal(visibility.length, 1); assert.equal(pointer.length, 1); assert.equal(key.length, 1);
  api.acknowledgeFinalization(receipt(expected), expected); h.writes.length = 0;
  const epoch = api.patientGeneration(); h.advance(api.IDLE_CLEAR_MS + 1);
  const callbacks = [...timerCallbacks, ...visibility, ...pointer, ...key, continueOld];
  for (const callback of callbacks) {
    callback(new Event('synthetic-old-callback')); await settle();
    assert.equal(api.hasAcknowledgedCompletion(), true); assert.equal(api.patientGeneration(), epoch);
    assert.equal(h.navigation.length, 0); wiped(h, api); assert.equal(h.writes.length, 0, 'not even a transient activity/retry write');
  }
  h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'));
  h.document.visibilityState = 'visible'; h.document.dispatchEvent(new Event('visibilitychange'));
  h.window.dispatchEvent(new Event('pointerdown')); h.window.dispatchEvent(new Event('keydown')); await settle();
  safety.render(); assert.equal(safety.tree.props.isOpen, false); assert.equal(h.closedNotifications, 1);
  assert.equal(api.hasAcknowledgedCompletion(), true); assert.equal(h.navigation.length, 0); assert.equal(h.writes.length, 0); wiped(h, api);
});

test('Safety remount and an already-rendered but delayed effect on old patient paths do not recreate completed activity', () => {
  for (const pathname of PATIENT_PATHS) for (const delayed of [false, true]) {
    const h = harness(pathname), api = h.load('utils/patientSession'), expected = session(h);
    const safety = delayed ? h.mount('components/PatientSafety.tsx', 'default', {}, false) : undefined;
    api.acknowledgeFinalization(receipt(expected), expected); h.writes.length = 0;
    const mounted = safety || h.mount(); if (delayed) mounted.commit();
    mounted.render(); assert.equal(mounted.tree.props.isOpen, false);
    button(mounted, '続ける')();
    assert.equal(h.intervals.size, 0); assert.equal(h.document.handlers('visibilitychange').length, 0);
    assert.equal(h.window.handlers('pointerdown').length, 0); assert.equal(h.window.handlers('keydown').length, 0);
    assert.equal(h.navigation.length, 0); assert.equal(h.writes.length, 0); assert.equal(api.hasAcknowledgedCompletion(), true); wiped(h, api);
  }
});

test('ordinary warning requires Continue, while active pointer/key activity still refreshes the timestamp', () => {
  const h = harness(), api = h.load('utils/patientSession'); session(h);
  const warningAt = String(h.now() - api.IDLE_WARNING_MS); h.storage.setItem('patient_last_activity', warningAt);
  const safety = h.mount(); safety.render(); assert.equal(safety.tree.props.isOpen, true);
  h.window.dispatchEvent(new Event('pointerdown')); h.window.dispatchEvent(new Event('keydown'));
  assert.equal(h.storage.getItem('patient_last_activity'), warningAt);
  button(safety, '続ける')(); safety.render(); assert.equal(safety.tree.props.isOpen, false);
  assert.equal(h.storage.getItem('patient_last_activity'), String(h.now()));
  for (const event of ['pointerdown', 'keydown']) {
    h.advance(1000); h.window.dispatchEvent(new Event(event));
    assert.equal(h.storage.getItem('patient_last_activity'), String(h.now()));
  }
  assert.equal(api.hasAcknowledgedCompletion(), false); assert.equal(h.navigation.length, 0);
});

test('ordinary idle timer, visibility, pointer, key and expired Continue still clear and return to top', () => {
  for (const trigger of ['timer', 'visibilitychange', 'pointerdown', 'keydown', 'continue']) {
    const h = harness(), api = h.load('utils/patientSession'); session(h);
    const safety = h.mount(), epoch = api.patientGeneration(), signal = api.patientSignal();
    h.advance(api.IDLE_CLEAR_MS);
    if (trigger === 'timer') [...h.intervals.values()].find(timer => timer.ms === 1000).callback();
    else if (trigger === 'continue') button(safety, '続ける')();
    else (trigger === 'visibilitychange' ? h.document : h.window).dispatchEvent(new Event(trigger));
    wiped(h, api); topNavigation(h); assert.equal(api.hasAcknowledgedCompletion(), false);
    assert.equal(api.patientGeneration(), epoch + 1); assert.equal(signal.aborted, true);
    safety.render(); assert.equal(safety.tree.props.isOpen, false);
  }
});

test('manual exit still clears all patient fields, aborts work and replaces the route with top', () => {
  const h = harness(), api = h.load('utils/patientSession'); session(h);
  h.storage.setItem('patient_name', 'SYNTHETIC'); h.storage.setItem('retry_queue', '[]');
  const safety = h.mount(), epoch = api.patientGeneration(), signal = api.patientSignal();
  button(safety, '入力を消去して終了')();
  wiped(h, api); topNavigation(h); assert.equal(api.hasAcknowledgedCompletion(), false);
  assert.equal(api.patientGeneration(), epoch + 1); assert.equal(signal.aborted, true); assert.equal(h.closedNotifications, 1);
});

test('pagehide and bfcache restoration reset the completion marker; ordinary pageshow does not', () => {
  for (const name of ['pagehide', 'pageshow']) {
    const h = harness('/done'), api = h.load('utils/patientSession'), expected = session(h); h.mount();
    api.acknowledgeFinalization(receipt(expected), expected);
    h.window.dispatchEvent(transition('pageshow', false));
    assert.equal(api.hasAcknowledgedCompletion(), true); assert.equal(h.navigation.length, 0);
    const epoch = api.patientGeneration(), signal = api.patientSignal(); h.writes.length = 0;
    h.window.dispatchEvent(transition(name, true));
    assert.equal(api.hasAcknowledgedCompletion(), false); assert.equal(api.patientGeneration(), epoch + 1);
    assert.equal(signal.aborted, true); assert.equal(h.writes.length, 0); wiped(h, api);
    if (name === 'pageshow') topNavigation(h); else assert.equal(h.navigation.length, 0);
    redirect(h.mount('components/PatientSafety.tsx', 'PatientGuard', { children: 'synthetic-child' }), '/');
  }
});

test('completion pages leave the success transition exclusively to PatientGuard', () => {
  for (const name of ['QuestionnaireForm', 'Questions', 'LlmWait']) {
    const source = fs.readFileSync(path.join(root, `pages/${name}.tsx`), 'utf8');
    assert.match(source, /await finalizePatient\(sessionId\)/, name);
    assert.doesNotMatch(source, /navigate\(\s*['"]\/done['"]/, name);
    assert.doesNotMatch(source, /setItem\(\s*['"]summary['"]/, name);
  }
});

test('real follow-up page continuations cannot revive questions or finalize after resolution-to-caller cleanup races', async () => {
  // A resolved thenable models patientJson having passed its own checks, followed by cleanup
  // before the caller's await continuation. This does not claim to model Router scheduling.
  for (const flow of ['llm-wait', 'fetch-questions', 'submit-questions']) for (const reason of ['ack', 'clear']) for (const outcome of ['questions', 'empty', 'error']) {
    const h = harness(), api = h.load('utils/patientSession'), expected = session(h);
    let finalizations = 0, resolutions = 0;
    h.mock('../utils/finalizePatient', { finalizePatient: async () => { finalizations++; } });
    h.mock('../retryQueue', { postWithRetry: async () => json({}) });
    h.mock('../utils/patientSession', { ...api, patientJson: () => ({ then(resolve, reject) {
      resolutions++;
      if (outcome === 'error') reject(new Error('synthetic-late-error'));
      else resolve({ questions: outcome === 'empty' ? [] : [{ id: 'synthetic-late', text: 'Synthetic question' }] });
      if (reason === 'ack') api.acknowledgeFinalization(receipt(expected), expected); else api.clearPatientSession();
      h.writes.length = 0;
    } }) });
    if (flow === 'submit-questions') h.storage.setItem('pending_llm_questions', '[{"id":"synthetic-first","text":"Synthetic first question"}]');
    const page = h.mount(flow === 'llm-wait' ? 'pages/LlmWait.tsx' : 'pages/Questions.tsx');
    if (flow === 'submit-questions') { page.render(); await button(page, 'まとめて送信')(); }
    await settle();
    assert.equal(resolutions, 1, `${flow}/${reason}/${outcome}`);
    wiped(h, api); assert.equal(h.writes.length, 0, 'no late questions, answers or llm_error write');
    assert.equal(api.hasAcknowledgedCompletion(), reason === 'ack');
    assert.equal(finalizations, 0); assert.equal(h.navigation.length, 0); assert.equal(h.notifications.length, 0);
  }
});
