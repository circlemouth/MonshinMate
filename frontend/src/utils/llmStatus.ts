/**
 * LLM 接続状態のユーティリティ。
 * - ステータススナップショットの取得（/system/llm-status）
 * - グローバルイベントの発火（llmStatusUpdated）
 */

export type LlmStatus = 'ok' | 'ng' | 'disabled' | 'pending';

export interface LlmStatusSnapshot {
  status: LlmStatus;
  detail?: string | null;
  source?: string | null;
  checkedAt?: string | null;
}

function normalizeStatus(raw: string | null | undefined, enabled: boolean): LlmStatus {
  if (raw === 'ok' || raw === 'ng' || raw === 'disabled' || raw === 'pending') {
    return raw;
  }
  return enabled ? 'pending' : 'disabled';
}

async function fetchSnapshot(): Promise<LlmStatusSnapshot> {
  try {
    const res = await fetch('/system/llm-status');
    if (!res.ok) {
      throw new Error('failed to load status');
    }
    const data = await res.json();
    const enabled = data?.status !== 'disabled';
    const status = normalizeStatus(data?.status, enabled);
    return {
      status,
      detail: data?.detail ?? null,
      source: data?.source ?? null,
      checkedAt: data?.checked_at ?? null,
    };
  } catch (error) {
    console.error('failed to fetch LLM status snapshot', error);
    return {
      status: 'ng',
      detail: 'status_fetch_failed',
      source: 'ui',
      checkedAt: null,
    };
  }
}

/** 現在の LLM 状態を問い合わせて返す。 */
export async function checkLlmStatus(): Promise<LlmStatus> {
  const snapshot = await fetchSnapshot();
  return snapshot.status;
}

/** 指定された状態を購読者へ通知する。 */
export function emitLlmStatus(snapshot: LlmStatusSnapshot) {
  try {
    const ev = new CustomEvent('llmStatusUpdated', { detail: snapshot });
    window.dispatchEvent(ev);
  } catch (error) {
    console.error('failed to emit llmStatusUpdated', error);
  }
}

/** 即時問い合わせて最新状態を通知する。 */
export async function refreshLlmStatus(): Promise<LlmStatusSnapshot> {
  const snapshot = await fetchSnapshot();
  emitLlmStatus(snapshot);
  return snapshot;
}

/** スナップショットを直接取得するためのヘルパー。 */
export async function fetchLlmStatusSnapshot(): Promise<LlmStatusSnapshot> {
  return fetchSnapshot();
}

