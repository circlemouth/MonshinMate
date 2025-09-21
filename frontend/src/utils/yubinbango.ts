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
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('yubinbango-core load error')));
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.charset = 'UTF-8';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('yubinbango-core load error'));
    document.body.appendChild(script);
  });

  return loadingPromise;
};

export const fetchAddressByPostal = async (postal: string): Promise<YubinBangoResult> => {
  const normalized = postal.replace(/[^0-9]/g, '').slice(0, 7);
  if (normalized.length !== 7) {
    throw new Error('郵便番号は7桁で入力してください');
  }
  await loadYubinbangoCore();
  return new Promise((resolve, reject) => {
    if (!window.YubinBangoCore) {
      reject(new Error('郵便番号検索ライブラリの読み込みに失敗しました'));
      return;
    }
    try {
      let resolved = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (window as any).YubinBangoCore(normalized, (addr: YubinBangoResult | null | undefined) => {
        resolved = true;
        if (!addr || (!addr.region && !addr.locality && !addr.street && !addr.extended)) {
          reject(new Error('該当する住所が見つかりませんでした'));
        } else {
          resolve(addr);
        }
      });
      setTimeout(() => {
        if (!resolved) {
          reject(new Error('住所検索がタイムアウトしました'));
        }
      }, 3000);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('住所検索に失敗しました'));
    }
  });
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
