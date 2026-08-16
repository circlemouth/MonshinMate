interface QueueItem {
  url: string;
  options: RequestInit;
  attempts: number;
  nextAttemptAt: number;
}

const KEY = 'retry_queue';

function load(): QueueItem[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

function save(q: QueueItem[]): void {
  sessionStorage.setItem(KEY, JSON.stringify(q));
}

export function enqueue(item: QueueItem): void {
  const q = load();
  const key = `${item.options.method || 'GET'}:${item.url}:${String(item.options.body || '')}`;
  const withoutDuplicate = q.filter(
    (queued) => `${queued.options.method || 'GET'}:${queued.url}:${String(queued.options.body || '')}` !== key,
  );
  withoutDuplicate.push(item);
  save(withoutDuplicate.slice(-50));
}

const isRetriableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

const retryDelay = (attempts: number) => Math.min(5 * 60_000, 2 ** Math.min(attempts, 8) * 1_000);

export async function flushQueue(): Promise<void> {
  const q = load();
  const remaining: QueueItem[] = [];
  for (const item of q) {
    if ((item.nextAttemptAt || 0) > Date.now()) {
      remaining.push(item);
      continue;
    }
    try {
      const res = await fetch(item.url, item.options);
      if (!res.ok && isRetriableStatus(res.status)) {
        const attempts = (item.attempts || 0) + 1;
        if (attempts < 8) {
          remaining.push({ ...item, attempts, nextAttemptAt: Date.now() + retryDelay(attempts) });
        }
      }
    } catch {
      const attempts = (item.attempts || 0) + 1;
      if (attempts < 8) {
        remaining.push({ ...item, attempts, nextAttemptAt: Date.now() + retryDelay(attempts) });
      }
    }
  }
  save(remaining);
}

export async function postWithRetry(url: string, body: any): Promise<Response | void> {
  const options: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      if (isRetriableStatus(res.status)) {
        enqueue({ url, options, attempts: 0, nextAttemptAt: Date.now() + retryDelay(0) });
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  } catch (error) {
    if (error instanceof TypeError) {
      enqueue({ url, options, attempts: 0, nextAttemptAt: Date.now() + retryDelay(0) });
      throw new Error('queued');
    }
    throw error;
  }
}
