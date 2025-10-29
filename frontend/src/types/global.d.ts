declare global {
  interface Window {
    __MONSHIN_CONFIG__?: {
      apiBaseUrl?: string;
    };
    __MONSHIN_FETCH_PATCHED__?: boolean;
  }
}

export {};
