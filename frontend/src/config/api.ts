const globalObj: any = typeof window !== 'undefined' ? window : {};
const monshinConfig = (globalObj.__MONSHIN_CONFIG__ ?? {}) as { apiBaseUrl?: string };

const apiBase = typeof monshinConfig.apiBaseUrl === 'string' ? monshinConfig.apiBaseUrl.trim().replace(/\/$/, '') : '';

function resolveUrl(input: string): string {
  if (!input) return input;
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  if (input.startsWith('//')) {
    return input;
  }
  if (!input.startsWith('/')) {
    input = `/${input}`;
  }
  if (!apiBase) {
    return input;
  }
  return `${apiBase}${input}`;
}

export function apiUrl(path: string): string {
  return resolveUrl(path);
}

export function setupApiFetch(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if ((window as any).__MONSHIN_FETCH_PATCHED__) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') {
      return originalFetch(resolveUrl(input), init);
    }
    if ((input as any)?.url) {
      // Request 互換のオブジェクト（SWR 等）を考慮
      const urlValue = typeof (input as any).url === 'function' ? (input as any).url() : (input as any).url;
      const nextUrl = resolveUrl(urlValue);
      if (nextUrl !== urlValue) {
        const cloned = new Request(nextUrl, input as RequestInit | Request);
        return originalFetch(cloned, init);
      }
    }
    if (input instanceof URL) {
      const next = resolveUrl(input.toString());
      if (next === input.toString()) {
        return originalFetch(input, init);
      }
      return originalFetch(next, init);
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;
  (window as any).__MONSHIN_FETCH_PATCHED__ = true;
}

export function getApiBaseUrl(): string {
  return apiBase;
}
