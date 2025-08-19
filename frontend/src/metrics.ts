// 匿名UIメトリクスの軽量収集（院内向け・個人特定情報は含めない）
// 収集先が未提供の場合は localStorage にバッファし、送信はベストエフォート

type EventName = 'page_view' | 'validation_failed' | 'print';

type EventPayload = {
  name: EventName;
  ts: number;
  path?: string;
  detail?: Record<string, any>;
};

const KEY = 'ui_metrics_buffer_v1';

export function track(name: EventName, detail?: Record<string, any>) {
  try {
    const buf: EventPayload[] = JSON.parse(localStorage.getItem(KEY) || '[]');
    const ev: EventPayload = { name, ts: Date.now(), path: location.pathname, detail };
    buf.push(ev);
    localStorage.setItem(KEY, JSON.stringify(buf).slice(0, 200000)); // 200KB 程度で上限
  } catch {
    // ignore
  }
}

export async function flushMetrics() {
  try {
    const buf: EventPayload[] = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!buf.length) return;
    // 送信先がない場合もあるためベストエフォート
    await fetch('/metrics/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: buf }),
    }).catch(() => {});
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// ページ離脱時に送信を試行
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    // 非同期は保証されないが、バッファは残るため問題なし
    void flushMetrics();
  });
}

