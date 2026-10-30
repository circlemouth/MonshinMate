/** Actual production React/BrowserRouter/App integration, with synthetic APIs only.
 * Build in an env-free source copy using npm run test:browser:build. The fixture
 * and its synthetic credentials are excluded from the Cloud Build allowlist.
 */
import {
  clearPatientSession, storePatientSession, getPatientSession, patientGeneration,
  PATIENT_CLEARED, PATIENT_STORAGE_KEYS, hasAcknowledgedCompletion, IDLE_CLEAR_MS,
} from '../src/utils/patientSession';

const runtime = import.meta.env.PROD ? 'production' : 'development StrictMode';
type Mode = 'success' | 'fail' | 'defer-finalize' | 'defer-questions';
let mode: Mode = 'success';
let serial = 0;
let pending: Array<() => void> = [];
let paths: string[] = [];
let results: Array<{ name: string; passed: boolean }> = [];
const root = () => document.getElementById('root')!;
const output = document.getElementById('completion-test-results')!;
const runButton = document.getElementById('run-completion-tests') as HTMLButtonElement;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const clean = () => PATIENT_STORAGE_KEYS.every(key => sessionStorage.getItem(key) === null);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => unknown, label: string) {
  const deadline = performance.now() + 6000;
  while (!check()) { if (performance.now() > deadline) throw new Error(`Timeout: ${label}`); await pause(10); }
}
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const text = () => root().textContent || '';
function click(label: string) {
  const button = [...root().querySelectorAll('button')].find(button => button.textContent?.trim() === label);
  assert(button && !button.disabled, `Enabled button missing: ${label}`);
  button!.click();
}
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method].bind(history);
  history[method] = (data, unused, url) => { paths.push(new URL(String(url), location.origin).pathname); return original(data, unused, url); };
}
function go(route: string) { history.pushState(null, '', route); window.dispatchEvent(new PopStateEvent('popstate')); }

// Exercise still-mounted safety listeners synchronously between cleanup and route commit.
window.addEventListener(PATIENT_CLEARED, () => {
  if (!hasAcknowledgedCompletion()) return;
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('pointerdown'));
  window.dispatchEvent(new Event('keydown'));
});
window.fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) throw new Error('External fetch forbidden in isolated synthetic fixture');
  const path = url.pathname;
  await pause(10);
  if (path === '/system/bootstrap') return json({ display_name: '隔離合成問診', completion_message: 'ご回答ありがとうございました。', entry_message: '合成テスト', theme_color: '#1e88e5', timezone: 'Asia/Tokyo', default_questionnaire_id: 'synthetic', logo: { url: null, crop: null } });
  if (path === '/questionnaires/synthetic/template') return json({ items: [] });
  if (path.endsWith('/answers') || path.endsWith('/llm-answers/batch')) return json({ status: 'ok', remaining_items: [] });
  if (path.endsWith('/llm-questions')) {
    if (mode === 'defer-questions') return new Promise<Response>(resolve => pending.push(() => resolve(json({ questions: [{ id: 'synthetic-late', text: '古い合成質問' }] }))));
    return json({ questions: [] });
  }
  if (/^\/sessions\/synthetic-\d+\/finalize$/.test(path)) {
    const id = path.split('/')[2];
    const receipt = { id, status: 'finalized', finalized_at: '2026-10-30T00:00:00Z' };
    if (mode === 'defer-finalize') return new Promise<Response>(resolve => pending.push(() => resolve(json(receipt))));
    return mode === 'fail' ? json({ detail: 'Synthetic unavailable' }, 503) : json(receipt);
  }
  throw new Error(`Unexpected synthetic API: ${path}`);
};
async function top() {
  clearPatientSession(); go('/');
  await until(() => text().includes('当院の受診は初めてですか？'), 'top screen');
  await frames();
  assert(clean() && !hasAcknowledgedCompletion(), 'Top must clear patient and terminal state');
}
async function start(route: string, nextMode: Mode = 'success') {
  mode = nextMode; paths = []; pending = [];
  const id = `synthetic-${++serial}`;
  storePatientSession({ id, session_token: `synthetic-not-a-real-token-${serial}`, expires_at: new Date(Date.now() + 3600000).toISOString() });
  sessionStorage.setItem('visit_type', 'followup');
  sessionStorage.setItem('patient_last_activity', String(Date.now()));
  sessionStorage.setItem('questionnaire_id', 'synthetic');
  sessionStorage.setItem('answers', '{}');
  sessionStorage.setItem('llm_followup_enabled', '0');
  if (route === '/questions') sessionStorage.setItem('pending_llm_questions', JSON.stringify([{ id: 'synthetic-q', text: '合成テスト質問' }]));
  go(route);
  if (route === '/questionnaire') await until(() => text().includes('次へ'), 'questionnaire');
  if (route === '/questions') await until(() => text().includes('まとめて送信'), 'questions');
  return id;
}
async function done() {
  await until(() => location.pathname === '/done' && text().includes('ご回答ありがとうございました。'), 'completion screen');
  await pause(1100);
  assert(location.pathname === '/done' && text().includes('ご回答ありがとうございました。'), 'Completion must remain visible after idle timer opportunity');
  assert(clean() && hasAcknowledgedCompletion(), 'Only non-identifying in-memory completion state may remain');
  assert(!paths.includes('/'), 'Successful completion must never redirect through top');
}
async function check(name: string, run: () => Promise<void>) {
  await run(); results.push({ name, passed: true });
  output.textContent = results.map(result => `PASS ${result.name}`).join('\n');
}
async function run() {
  runButton.disabled = true; results = [];
  try {
    for (const route of ['/questionnaire', '/questions', '/llm-wait']) {
      await check(`normal completion ${route}`, async () => {
        await top(); await start(route);
        if (route !== '/llm-wait') click(route === '/questionnaire' ? '次へ' : 'まとめて送信');
        await done();
      });
    }
    await check('failed finalization retains answers and retries successfully', async () => {
      await top(); await start('/questionnaire', 'fail'); click('次へ');
      await until(() => document.body.textContent?.includes('送信完了を確認できませんでした。'), 'failure notification');
      assert(location.pathname === '/questionnaire' && !!getPatientSession() && sessionStorage.getItem('answers') === '{}' && !hasAcknowledgedCompletion(), 'Failure must retain active patient');
      mode = 'success';
      const retry = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '再試行');
      assert(retry, 'Retry action missing'); retry!.click(); await done();
    });
    await check('returning to an old patient route never restores the form', async () => {
      paths = []; go('/questions'); await done();
    });
    await check('next patient resets the terminal state', async () => {
      click('最初の画面に戻る');
      await until(() => text().includes('当院の受診は初めてですか？'), 'explicit top action'); await frames();
      assert(clean() && !hasAcknowledgedCompletion(), 'Explicit next-patient action must reset completion');
      await start('/questionnaire'); assert(!hasAcknowledgedCompletion() && !!getPatientSession(), 'New patient must not inherit completion');
    });
    await check('manual cancellation still clears and returns to top', async () => {
      clearPatientSession();
      await until(() => location.pathname === '/' && text().includes('当院の受診は初めてですか？'), 'manual cancellation'); await frames();
      assert(clean() && !hasAcknowledgedCompletion(), 'Cancellation must not be a completion');
    });
    await check('idle expiry still clears and returns to top', async () => {
      await top(); await start('/questionnaire');
      sessionStorage.setItem('patient_last_activity', String(Date.now() - IDLE_CLEAR_MS));
      document.dispatchEvent(new Event('visibilitychange'));
      await until(() => location.pathname === '/' && text().includes('当院の受診は初めてですか？'), 'idle expiry'); await frames();
      assert(clean() && !hasAcknowledgedCompletion(), 'Idle expiry must not be a completion');
    });
    for (const lateMode of ['defer-finalize', 'defer-questions'] as const) {
      await check(`late ${lateMode} cannot redirect or restore data after next patient starts`, async () => {
        await top(); await start(lateMode === 'defer-finalize' ? '/questionnaire' : '/llm-wait', lateMode);
        if (lateMode === 'defer-finalize') click('次へ');
        await until(() => pending.length > 0, 'deferred response');
        const release = [...pending];
        await top(); const id = await start('/questionnaire'); const generation = patientGeneration();
        release.forEach(resolve => resolve()); await pause(100); await frames();
        assert(location.pathname === '/questionnaire' && getPatientSession()?.id === id && patientGeneration() === generation && !hasAcknowledgedCompletion(), 'Late response must not change next patient');
        assert(sessionStorage.getItem('pending_llm_questions') === null && sessionStorage.getItem('llm_error') === null, 'Old question/error must not be resurrected');
      });
    }
    await check('pagehide and BFCache restore clear completed state', async () => {
      await top(); await start('/questionnaire'); click('次へ'); await done();
      window.dispatchEvent(new Event('pagehide'));
      const event = new Event('pageshow'); Object.defineProperty(event, 'persisted', { value: true }); window.dispatchEvent(event);
      await until(() => location.pathname === '/' && text().includes('当院の受診は初めてですか？'), 'BFCache cleanup'); await frames();
      assert(clean() && !hasAcknowledgedCompletion(), 'Page lifecycle must clear terminal state');
    });
    output.textContent += `\nALL ${results.length} TESTS PASSED (${runtime} React/Router; synthetic APIs only)`;
  } catch (error) {
    output.textContent += `\nFAIL ${error instanceof Error ? error.message : 'Unknown test error'}`;
  } finally { runButton.disabled = false; }
}
runButton.onclick = () => { void run(); };
history.replaceState(null, '', '/');
void import('../src/main').then(async () => { await until(() => text().includes('当院の受診は初めてですか？'), 'application bootstrap'); runButton.disabled = false; output.textContent = `Ready — ${runtime} / isolated synthetic APIs`; });
