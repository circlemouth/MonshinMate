import { useEffect, useState } from 'react';

declare global {
  interface Window {
    YubinBangoCore?: new (
      postal: string,
      callback: (addr: YubinBangoResult | null | undefined) => void,
    ) => unknown;
  }
}

export interface YubinBangoResult {
  region_id?: string;
  region?: string;
  locality?: string;
  street?: string;
  extended?: string;
}

const SCRIPT_SRC = 'https://yubinbango.github.io/yubinbango-core/yubinbango-core.js';
let loadingPromise: Promise<void> | null = null;

export const loadYubinbangoCore = (): Promise<void> => {
  if (window.YubinBangoCore) return Promise.resolve();
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`) as HTMLScriptElement | null;
    // If script tag exists and global is already available, resolve immediately
    if (existing && window.YubinBangoCore) {
      resolve();
      return;
    }

    const onLoaded = () => {
      if (window.YubinBangoCore) {
        resolve();
      } else {
        reject(new Error('yubinbango-core loaded but global missing'));
      }
    };
    const onError = () => reject(new Error('yubinbango-core load error'));

    const script = existing ?? document.createElement('script');
    if (!existing) {
      script.src = SCRIPT_SRC;
      script.charset = 'UTF-8';
      script.async = true;
      script.crossOrigin = 'anonymous';
      // Mark so we know we created it
      script.setAttribute('data-yubinbango', '1');
      document.body.appendChild(script);
    }
    script.addEventListener('load', onLoaded, { once: true });
    script.addEventListener('error', onError, { once: true });

    // Safety timeout to avoid hanging forever if CSP blocks the load
    const tid = setTimeout(() => {
      if (!window.YubinBangoCore) {
        reject(new Error('yubinbango-core load timeout'));
      }
    }, 4000);
    // If resolved/rejected early, clear timeout
    loadingPromise?.finally(() => clearTimeout(tid));
  });

  return loadingPromise;
};

// Fallback: ZipCloud API (https://zipcloud.ibsnet.co.jp/doc/api)
const fetchViaZipCloud = async (postal: string): Promise<YubinBangoResult> => {
  const normalized = postal.replace(/[^0-9]/g, '').slice(0, 7);
  const url = `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${normalized}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('住所検索API応答エラー');
  const data = await res.json();
  if (data.status !== 200 || !Array.isArray(data.results) || data.results.length === 0) {
    throw new Error(data.message || '該当する住所が見つかりませんでした');
  }
  const r = data.results[0];
  return {
    region: r.address1 || '',
    locality: r.address2 || '',
    street: r.address3 || '',
    extended: '',
  };
};

// Prefer server-side lookup to avoid CSP/CORS issues on clients
const fetchViaBackend = async (postal: string): Promise<YubinBangoResult> => {
  const normalized = postal.replace(/[^0-9]/g, '').slice(0, 7);
  const res = await fetch(`/address/lookup?postal=${normalized}`);
  if (!res.ok) {
    // Extract error if available
    try {
      const data = await res.json();
      const detail = (data && (data.detail || data.message)) || '';
      throw new Error(detail || '住所検索に失敗しました');
    } catch {
      throw new Error('住所検索に失敗しました');
    }
  }
  return await res.json();
};

export const fetchAddressByPostal = async (postal: string): Promise<YubinBangoResult> => {
  const normalized = postal.replace(/[^0-9]/g, '').slice(0, 7);
  if (normalized.length !== 7) {
    throw new Error('郵便番号は7桁で入力してください');
  }
  // Try backend first (server-side proxy), then client-side fallbacks
  try {
    return await fetchViaBackend(normalized);
  } catch (primaryError) {
    // Fallback path: try direct ZipCloud, then yubinbango-core as last resort
    try {
      return await fetchViaZipCloud(normalized);
    } catch (fallbackError) {
      try {
        await loadYubinbangoCore();
        if (!window.YubinBangoCore) throw new Error('郵便番号検索ライブラリの読み込みに失敗しました');
        return await new Promise((resolve, reject) => {
          try {
            let done = false;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            new (window as any).YubinBangoCore(normalized, (addr: YubinBangoResult | null | undefined) => {
              done = true;
              if (!addr || (!addr.region && !addr.locality && !addr.street && !addr.extended)) {
                reject(new Error('該当する住所が見つかりませんでした'));
              } else {
                resolve(addr);
              }
            });
            setTimeout(() => {
              if (!done) reject(new Error('住所検索がタイムアウトしました'));
            }, 3000);
          } catch (e) {
            reject(e instanceof Error ? e : new Error('住所検索に失敗しました'));
          }
        });
      } catch (lastError) {
        const message =
          (lastError instanceof Error ? lastError.message : '') ||
          (fallbackError instanceof Error ? fallbackError.message : '') ||
          (primaryError instanceof Error ? primaryError.message : '住所検索に失敗しました');
        throw new Error(message);
      }
    }
  }
};

export const useYubinbangoAutoLoad = () => {
  const [ready, setReady] = useState<boolean>(!!window.YubinBangoCore);
  useEffect(() => {
    if (window.YubinBangoCore) {
      setReady(true);
      return;
    }
    let mounted = true;
    loadYubinbangoCore()
      .then(() => {
        if (mounted) setReady(true);
      })
      .catch(() => {
        if (mounted) setReady(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  return ready;
};
