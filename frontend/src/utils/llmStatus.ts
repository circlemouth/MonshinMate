/**
 * LLM 接続状態のユーティリティ。
 * - 状態の判定（/llm/settings, /llm/settings/test）
 * - グローバルイベントの発火（llmStatusUpdated）
 */

export type LlmStatus = 'ok' | 'ng' | 'disabled';

/** 現在の LLM 状態を問い合わせて返す。 */
export async function checkLlmStatus(): Promise<LlmStatus> {
  try {
    const s = await fetch('/llm/settings').then((r) => r.json());
    if (!s?.enabled) return 'disabled';
    const t = await fetch('/llm/settings/test', { method: 'POST' }).then((r) => r.json());
    return t?.status === 'ok' ? 'ok' : 'ng';
  } catch {
    return 'ng';
  }
}

/** 指定された状態を購読者へ通知する。 */
export function emitLlmStatus(status: LlmStatus) {
  try {
    const ev = new CustomEvent('llmStatusUpdated', { detail: status });
    window.dispatchEvent(ev);
  } catch {}
}

/** 即時問い合わせて最新状態を通知する。 */
export async function refreshLlmStatus(): Promise<LlmStatus> {
  const st = await checkLlmStatus();
  emitLlmStatus(st);
  return st;
}

