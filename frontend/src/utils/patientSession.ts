export const PATIENT_CLEARED = 'patientSessionCleared';
export const PATIENT_STORAGE_KEYS = [
  'session_id', 'session_token', 'session_expires_at', 'answers', 'questionnaire_items',
  'questionnaire_id', 'summary', 'visit_type', 'llm_error', 'patient_name', 'dob', 'gender',
  'personal_info', 'pending_llm_questions', 'llm_followup_enabled', 'retry_queue', 'patient_last_activity',
] as const;
export const IDLE_WARNING_MS = 15 * 60_000;
export const IDLE_CLEAR_MS = 16 * 60_000;
export function patientIdleState(): 'active' | 'warning' | 'expired' {
  const raw = sessionStorage.getItem('patient_last_activity');
  const last = Number(raw);
  const elapsed = Date.now() - last;
  if (!raw || !Number.isFinite(last) || elapsed < 0 || elapsed >= IDLE_CLEAR_MS) return 'expired';
  return elapsed >= IDLE_WARNING_MS ? 'warning' : 'active';
}
export function canAccessPatientRoute(entry = false): boolean {
  return !!sessionStorage.getItem('visit_type') && (entry || !!getPatientSession());
}
export interface PatientSession { id: string; token: string; expiresAt: number }
let generation = 0;
let controller = new AbortController();

export const patientGeneration = () => generation;
export const isPatientGeneration = (value: number) => value === generation;
export const patientSignal = () => controller.signal;

export function clearPatientSession(): void {
  generation += 1;
  controller.abort();
  controller = new AbortController();
  PATIENT_STORAGE_KEYS.forEach(key => sessionStorage.removeItem(key));
  window.dispatchEvent(new Event(PATIENT_CLEARED));
}

export function getPatientSession(): PatientSession | null {
  const id = sessionStorage.getItem('session_id');
  const token = sessionStorage.getItem('session_token');
  const expiresAt = Date.parse(sessionStorage.getItem('session_expires_at') || '');
  if (!id || !token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { id, token, expiresAt };
}

export function storePatientSession(data: { id: string; session_token: string; expires_at: string }): void {
  if (!data.id || !data.session_token || !(Date.parse(data.expires_at) > Date.now())) throw new Error('セッション情報が無効です');
  // Invalidate pending work from any previous session, without deleting the current entry form.
  generation += 1;
  controller.abort();
  controller = new AbortController();
  sessionStorage.removeItem('retry_queue');
  sessionStorage.setItem('session_id', data.id);
  sessionStorage.setItem('session_token', data.session_token);
  sessionStorage.setItem('session_expires_at', data.expires_at);
}

export function isCurrentPatient(session: PatientSession): boolean {
  const current = getPatientSession();
  return !!current && current.id === session.id && current.token === session.token;
}

export async function patientFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const session = getPatientSession();
  const requestUrl = new URL(url, window.location.origin);
  if (!session || requestUrl.origin !== window.location.origin || !requestUrl.pathname.startsWith(`/sessions/${encodeURIComponent(session.id)}/`) || requestUrl.search) {
    throw new Error('現在の問診セッションでは利用できません');
  }
  const epoch = generation;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.token}`);
  const response = await fetch(url, { ...init, headers, signal: controller.signal, cache: 'no-store', redirect: 'error' });
  if (epoch !== generation || !isCurrentPatient(session)) throw new Error('問診セッションが切り替わりました');
  return response;
}

export async function patientJson(url: string, init: RequestInit = {}) {
  const epoch = generation;
  const response = await patientFetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (epoch !== generation) throw new Error('問診セッションが切り替わりました');
  return data;
}

export function acknowledgeFinalization(receipt: { status?: string; id?: string; finalized_at?: string }, expected: PatientSession): void {
  if (!isCurrentPatient(expected) || receipt.id !== expected.id || receipt.status !== 'finalized' || !receipt.finalized_at) {
    throw new Error('完了確認を取得できませんでした。再試行してください。');
  }
  clearPatientSession();
}
