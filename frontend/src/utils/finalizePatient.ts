import { flushQueue, hasPendingRetries } from '../retryQueue';
import { acknowledgeFinalization, getPatientSession, isCurrentPatient, patientJson } from './patientSession';

// A lost response is retried explicitly against the same ID; the server returns the same receipt.
export async function finalizePatient(id: string): Promise<void> {
  const session = getPatientSession();
  if (!session || session.id !== id) throw new Error('現在の問診セッションではありません');
  await flushQueue(true);
  if (!isCurrentPatient(session) || hasPendingRetries()) throw new Error('未送信の回答があります。接続を確認して再試行してください。');
  const receipt = await patientJson(`/sessions/${id}/finalize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llm_error: sessionStorage.getItem('llm_error') }),
  });
  acknowledgeFinalization(receipt, session);
}
