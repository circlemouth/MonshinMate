export const ADMIN_AUTH_CHANGED = 'adminAuthChanged';
let generation = 0;
let controller = new AbortController();
export function getAdminAccessToken(): string | null { return sessionStorage.getItem('adminAccessToken'); }
export function adminSnapshot() {
  const epoch = generation, token = getAdminAccessToken(), signal = controller.signal;
  const current = () => epoch === generation && token === getAdminAccessToken() && !signal.aborted;
  return { signal, current, assertCurrent: () => { if (!current()) throw new DOMException('管理者セッションが切り替わりました', 'AbortError'); } };
}
function invalidateRequests() { generation++; controller.abort(); controller = new AbortController(); }
export function clearAdminSession(): void {
  invalidateRequests();
  sessionStorage.removeItem('adminAccessToken'); sessionStorage.removeItem('adminLoggedIn');
  sessionStorage.removeItem('monshin.admin.latestFinalizedAt');
  window.dispatchEvent(new Event(ADMIN_AUTH_CHANGED));
}
export function acceptAdminToken(data: { access_token?: string }): void {
  if (!data.access_token) throw new Error('認証トークンがありません。再度ログインしてください。');
  invalidateRequests();
  sessionStorage.setItem('adminAccessToken', data.access_token); sessionStorage.setItem('adminLoggedIn', '1');
  window.dispatchEvent(new Event(ADMIN_AUTH_CHANGED));
}
export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('管理APIは同一オリジンのみ利用できます');
  const snapshot = adminSnapshot(), token = getAdminAccessToken();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  if (!headers.has('Authorization') && token) headers.set('Authorization', `Bearer ${token}`);
  const callerSignal = init.signal || (input instanceof Request ? input.signal : undefined);
  const requestController = new AbortController();
  const abort = () => requestController.abort();
  if (snapshot.signal.aborted || callerSignal?.aborted) abort();
  snapshot.signal.addEventListener('abort', abort, { once: true }); callerSignal?.addEventListener('abort', abort, { once: true });
  const assertCurrent = () => { snapshot.assertCurrent(); if (callerSignal?.aborted) throw new DOMException('処理を中止しました', 'AbortError'); };
  try {
    const response = await fetch(input, { ...init, signal: requestController.signal, headers, cache: 'no-store', redirect: 'error' });
    assertCurrent();
    if (response.status === 401) { clearAdminSession(); return response; }
    // Guard every body consumer as logout can happen after headers arrive.
    const guardResponse = (response: Response): Response => new Proxy(response, { get(target, property) {
      if (property === 'clone') return () => { assertCurrent(); return guardResponse(target.clone()); };
      if (['json', 'text', 'blob', 'arrayBuffer', 'formData'].includes(String(property))) {
        return async (...args: unknown[]) => { assertCurrent(); const value = await (target as any)[property](...args); assertCurrent(); return value; };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return guardResponse(response);
  } finally {
    snapshot.signal.removeEventListener('abort', abort); callerSignal?.removeEventListener('abort', abort);
  }
}
export async function adminDownload(url: string): Promise<void> {
  const snapshot = adminSnapshot();
  try {
    const response = await adminFetch(url);
    if (!response.ok) throw new Error('ダウンロードに失敗しました');
    const blob = await response.blob(); snapshot.assertCurrent();
    const objectUrl = URL.createObjectURL(blob), link = document.createElement('a');
    const filename = (response.headers.get('Content-Disposition') || '').match(/filename="?([^";]+)"?/i)?.[1];
    link.href = objectUrl; link.download = filename || (url.includes('/bulk/') ? 'sessions.zip' : `session.${url.split('/').pop()?.split('?')[0] || 'bin'}`);
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch { if (snapshot.current()) window.alert('ダウンロードできませんでした。認証と接続を確認してください。'); }
}
export async function adminJson(path: string, body: unknown, extraHeaders: HeadersInit = {}, signal?: AbortSignal) {
  const snapshot = adminSnapshot();
  const headers = new Headers(extraHeaders); headers.set('Content-Type', 'application/json');
  const response = await adminFetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({}));
  snapshot.assertCurrent();
  if (signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError');
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '認証処理に失敗しました。入力内容または有効期限を確認してください。');
  return data;
}
