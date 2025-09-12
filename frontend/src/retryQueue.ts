interface QueueItem {
  url: string;
  options: RequestInit;
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
  q.push(item);
  save(q);
}

export async function flushQueue(): Promise<void> {
  const q = load();
  const remaining: QueueItem[] = [];
  for (const item of q) {
    try {
      const res = await fetch(item.url, item.options);
      if (!res.ok) throw new Error('http error');
    } catch {
      remaining.push(item);
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch {
    enqueue({ url, options });
    throw new Error('queued');
  }
}

