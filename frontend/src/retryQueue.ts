import { getPatientSession, isCurrentPatient, patientFetch, type PatientSession } from './utils/patientSession';

interface QueueItem {
  key: string;
  url: string;
  body: string;
  session: PatientSession;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}
const KEY = 'retry_queue';
export const QUEUE_TTL_MS = 30 * 60_000;
let flushing: Promise<void> | null = null;
const isRetriableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
const retryDelay = (attempts: number) => Math.min(5 * 60_000, 2 ** Math.min(attempts, 8) * 1000);
const allowedUrl = (url: string, session: PatientSession) =>
  url === `/sessions/${session.id}/answers` || url === `/sessions/${session.id}/llm-answers/batch`;

function load(): QueueItem[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((item: QueueItem) => item.session && isCurrentPatient(item.session) &&
      allowedUrl(item.url, item.session) && typeof item.body === 'string' &&
      Number.isFinite(item.createdAt) && Date.now() - item.createdAt < QUEUE_TTL_MS && item.createdAt <= Date.now());
  } catch { return []; }
}
function save(queue: QueueItem[]) {
  if (queue.length) sessionStorage.setItem(KEY, JSON.stringify(queue));
  else sessionStorage.removeItem(KEY);
}
export function clearRetryQueue(): void { sessionStorage.removeItem(KEY); }
export function hasPendingRetries(): boolean { const queue = load(); save(queue); return queue.length > 0; }

function enqueue(url: string, body: string, session: PatientSession): void {
  if (!isCurrentPatient(session) || !allowedUrl(url, session)) return;
  const queue = load().filter(item => item.url !== url);
  queue.push({ key: crypto.randomUUID(), url, body, session, createdAt: Date.now(), attempts: 0, nextAttemptAt: Date.now() + retryDelay(0) });
  save(queue.slice(-50));
}
function discardUrl(url: string, session: PatientSession) {
  if (isCurrentPatient(session)) save(load().filter(item => item.url !== url));
}

export async function flushQueue(force = false): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const snapshot = load();
    save(snapshot);
    for (const item of snapshot) {
      if (!isCurrentPatient(item.session)) return;
      if (!load().some(current => current.key === item.key)) continue;
      if (item.attempts >= 8 || (!force && item.nextAttemptAt > Date.now())) continue;
      let retry = false;
      let succeeded = false;
      try {
        const response = await patientFetch(item.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: item.body });
        succeeded = response.ok;
        retry = !response.ok && isRetriableStatus(response.status);
      } catch { retry = true; }
      // Never recreate data cleared while a request was in flight, or overwrite a newer answer.
      if (!isCurrentPatient(item.session)) return;
      const current = load();
      const index = current.findIndex(value => value.key === item.key);
      if (index < 0) continue;
      if (succeeded) current.splice(index, 1);
      else if (retry && item.attempts < 7) current[index] = { ...item, attempts: item.attempts + 1, nextAttemptAt: Date.now() + retryDelay(item.attempts + 1) };
      // Preserve failed required answers as blockers until the patient explicitly resubmits.
      else current[index] = { ...item, attempts: 8 };
      save(current);
    }
  })();
  try { await flushing; } finally { flushing = null; }
}

export async function postWithRetry(url: string, body: unknown): Promise<Response> {
  const session = getPatientSession();
  if (!session || !allowedUrl(url, session)) throw new Error('現在の問診では再送できません');
  // A foreground save supersedes older queued values. Wait for any already-started retry first.
  if (flushing) await flushing;
  if (!isCurrentPatient(session)) throw new Error('問診セッションが切り替わりました');
  discardUrl(url, session);
  const serialized = JSON.stringify(body);
  let response: Response;
  try {
    response = await patientFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialized });
  } catch (error) {
    if (error instanceof TypeError) enqueue(url, serialized, session);
    throw error;
  }
  if (!response.ok) {
    if (isRetriableStatus(response.status)) enqueue(url, serialized, session);
    throw new Error(`HTTP ${response.status}`);
  }
  return response;
}
