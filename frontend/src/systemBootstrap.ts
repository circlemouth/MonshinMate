export type SystemLogo = {
  url: string | null;
  crop: { x: number; y: number; w: number; h: number } | null;
};

export type SystemBootstrap = {
  timezone: string;
  display_name: string;
  completion_message: string;
  entry_message: string;
  theme_color: string;
  logo: SystemLogo;
  default_questionnaire_id: string;
};

export const DEFAULT_SYSTEM_BOOTSTRAP: SystemBootstrap = {
  timezone: 'Asia/Tokyo',
  display_name: '問診メイト',
  completion_message: 'ご回答ありがとうございました。',
  entry_message: '不明点があれば受付にお知らせください',
  theme_color: '#1e88e5',
  logo: { url: null, crop: null },
  default_questionnaire_id: 'default',
};

let cachedBootstrap: SystemBootstrap | null = null;
let bootstrapRequest: Promise<SystemBootstrap> | null = null;

const normalizeBootstrap = (raw: Partial<SystemBootstrap> | null | undefined): SystemBootstrap => ({
  timezone: raw?.timezone || DEFAULT_SYSTEM_BOOTSTRAP.timezone,
  display_name: raw?.display_name || DEFAULT_SYSTEM_BOOTSTRAP.display_name,
  completion_message: raw?.completion_message || DEFAULT_SYSTEM_BOOTSTRAP.completion_message,
  entry_message: raw?.entry_message || DEFAULT_SYSTEM_BOOTSTRAP.entry_message,
  theme_color: raw?.theme_color || DEFAULT_SYSTEM_BOOTSTRAP.theme_color,
  logo: {
    url: raw?.logo?.url ?? null,
    crop: raw?.logo?.crop ?? null,
  },
  default_questionnaire_id:
    raw?.default_questionnaire_id || DEFAULT_SYSTEM_BOOTSTRAP.default_questionnaire_id,
});

/** 同一ページ内の初期設定取得を1リクエストへ集約する。 */
export function loadSystemBootstrap(): Promise<SystemBootstrap> {
  if (cachedBootstrap) return Promise.resolve(cachedBootstrap);
  if (bootstrapRequest) return bootstrapRequest;

  bootstrapRequest = fetch('/system/bootstrap')
    .then(async (response) => {
      if (!response.ok) throw new Error('failed to load system bootstrap');
      cachedBootstrap = normalizeBootstrap(await response.json());
      return cachedBootstrap;
    })
    .finally(() => {
      bootstrapRequest = null;
    });
  return bootstrapRequest;
}

/** 管理画面で保存した値を同一ページ内の共有キャッシュにも反映する。 */
export function patchSystemBootstrap(patch: Partial<SystemBootstrap>): void {
  if (!cachedBootstrap) return;
  cachedBootstrap = normalizeBootstrap({
    ...cachedBootstrap,
    ...patch,
    logo: patch.logo ? { ...cachedBootstrap.logo, ...patch.logo } : cachedBootstrap.logo,
  });
}
