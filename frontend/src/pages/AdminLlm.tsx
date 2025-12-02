import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Input,
  Select,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  NumberInput,
  NumberInputField,
  NumberInputStepper,
  NumberIncrementStepper,
  NumberDecrementStepper,
  Stack,
  Switch,
  Text,
  Textarea,
  VStack,
  Spinner,
} from '@chakra-ui/react';
import { RepeatIcon } from '@chakra-ui/icons';
import { refreshLlmStatus } from '../utils/llmStatus';
import { useNotify } from '../contexts/NotificationContext';

const DEFAULT_SYSTEM_PROMPT =
  'あなたは日本語で応答する熟練した医療問診支援AIです。患者の入力を理解し、医学的に適切で簡潔な回答や質問を行ってください。不要な前置きや断り書きは避け、常に敬体で表現してください。';

const DEFAULT_FOLLOWUP_TIMEOUT = 30;
const KNOWN_PROFILE_FIELDS = new Set([
  'model',
  'temperature',
  'system_prompt',
  'base_url',
  'api_key',
  'followup_timeout_seconds',
]);

type FeedbackVariant = 'info' | 'success' | 'warning' | 'error';

interface ProviderFieldMeta {
  key: string;
  label?: string;
  type?: 'text' | 'password' | 'textarea' | 'number' | 'select' | 'file';
  required?: boolean;
  helper?: string;
  placeholder?: string;
  options?: Array<{ label?: string; value?: string }>;
  min?: number;
  max?: number;
  step?: number;
  accept?: string;
}

interface ProviderMeta {
  key: string;
  label: string;
  description: string;
  helper?: string;
  use_base_url?: boolean;
  use_api_key?: boolean;
  default_profile?: Record<string, any>;
  extra_fields?: ProviderFieldMeta[];
}

interface ProviderProfile {
  model: string;
  temperature: number;
  system_prompt: string;
  base_url: string;
  api_key: string;
  followup_timeout_seconds: number;
  [key: string]: any;
}

interface SettingsState {
  provider: string;
  enabled: boolean;
  profiles: Record<string, ProviderProfile>;
}

const FALLBACK_PROVIDER_META: Record<string, ProviderMeta> = {
  ollama: {
    key: 'ollama',
    label: 'Ollama',
    description: 'ローカルで稼働する Ollama サーバー向けの設定です。',
    helper: 'ベースURLが空の場合は http://localhost:11434 を使用します。',
    default_profile: {
      base_url: 'http://localhost:11434',
      api_key: '',
      model: '',
      temperature: 0.2,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
      followup_timeout_seconds: DEFAULT_FOLLOWUP_TIMEOUT,
    },
  },
  lm_studio: {
    key: 'lm_studio',
    label: 'LM Studio',
    description: 'LM Studio のWebサーバーへ接続してモデルを利用します。',
    helper: 'LM Studio の Web UI に表示されるエンドポイントURLを入力してください。',
    default_profile: {
      base_url: 'http://localhost:1234',
      api_key: '',
      model: '',
      temperature: 0.2,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
      followup_timeout_seconds: DEFAULT_FOLLOWUP_TIMEOUT,
    },
  },
  openai: {
    key: 'openai',
    label: 'OpenAI (互換API含む)',
    description: 'OpenAI / Azure OpenAI / 互換API サービスを利用します。',
    helper: 'ベースURLに https://api.openai.com 等を設定し、APIキーを入力してください。',
    default_profile: {
      base_url: 'https://api.openai.com',
      api_key: '',
      model: '',
      temperature: 0.2,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
      followup_timeout_seconds: DEFAULT_FOLLOWUP_TIMEOUT,
    },
  },
};

const FALLBACK_PROVIDER_ORDER = Object.keys(FALLBACK_PROVIDER_META);

const severityRank: Record<FeedbackVariant, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
};

const normalizeTemp = (val: unknown): number => {
  const num = typeof val === 'number' ? val : parseFloat(String(val ?? ''));
  if (!Number.isFinite(num)) return 0.2;
  return Math.min(2, Math.max(0, num));
};

const normalizeTimeout = (val: unknown): number => {
  const num = typeof val === 'number' ? val : parseFloat(String(val ?? ''));
  if (!Number.isFinite(num)) return DEFAULT_FOLLOWUP_TIMEOUT;
  const clamped = Math.min(120, Math.max(5, num));
  return Math.round(clamped);
};

const fallbackBaseUrl = (provider: string): string => {
  switch (provider) {
    case 'ollama':
      return 'http://localhost:11434';
    case 'openai':
      return 'https://api.openai.com';
    case 'lm_studio':
    default:
      return 'http://localhost:1234';
  }
};

const resolveDefaultBaseUrl = (provider: string, metaMap: Record<string, ProviderMeta>): string => {
  const candidate = metaMap[provider]?.default_profile?.base_url;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate;
  }
  return fallbackBaseUrl(provider);
};

const defaultProfile = (provider: string, metaMap: Record<string, ProviderMeta>): ProviderProfile => {
  const metaDefaults = (metaMap[provider]?.default_profile ?? {}) as Record<string, any>;
  const systemPrompt =
    typeof metaDefaults.system_prompt === 'string' && metaDefaults.system_prompt.trim().length > 0
      ? metaDefaults.system_prompt
      : DEFAULT_SYSTEM_PROMPT;
  const profile: ProviderProfile = {
    model: typeof metaDefaults.model === 'string' ? metaDefaults.model : '',
    temperature: normalizeTemp(metaDefaults.temperature ?? 0.2),
    system_prompt: systemPrompt,
    base_url: typeof metaDefaults.base_url === 'string' ? metaDefaults.base_url : resolveDefaultBaseUrl(provider, metaMap),
    api_key: typeof metaDefaults.api_key === 'string' ? metaDefaults.api_key : '',
    followup_timeout_seconds: normalizeTimeout(metaDefaults.followup_timeout_seconds ?? DEFAULT_FOLLOWUP_TIMEOUT),
  };
  Object.entries(metaDefaults).forEach(([key, value]) => {
    if (!KNOWN_PROFILE_FIELDS.has(key)) {
      profile[key] = value;
    }
  });
  return profile;
};

const ensureProviderKey = (value: unknown, candidates: string[]): string => {
  const str = typeof value === 'string' ? value : '';
  if (str && candidates.includes(str)) return str;
  return candidates[0] ?? FALLBACK_PROVIDER_ORDER[0] ?? 'ollama';
};

const hydrateProfile = (
  provider: string,
  raw: any,
  fallback: any,
  metaMap: Record<string, ProviderMeta>,
): ProviderProfile => {
  const base = defaultProfile(provider, metaMap);
  const candidate = raw ?? {};
  const fb = fallback ?? {};
  const model = typeof candidate.model === 'string' ? candidate.model : typeof fb.model === 'string' ? fb.model : base.model;
  const baseUrlSource =
    candidate.base_url !== undefined ? candidate.base_url : fb.base_url !== undefined ? fb.base_url : base.base_url;
  const apiKeySource =
    candidate.api_key !== undefined ? candidate.api_key : fb.api_key !== undefined ? fb.api_key : base.api_key;
  const promptSource =
    candidate.system_prompt !== undefined ? candidate.system_prompt : fb.system_prompt !== undefined ? fb.system_prompt : base.system_prompt;
  const temperatureSource =
    candidate.temperature !== undefined ? candidate.temperature : fb.temperature !== undefined ? fb.temperature : base.temperature;
  const timeoutSource =
    candidate.followup_timeout_seconds !== undefined
      ? candidate.followup_timeout_seconds
      : fb.followup_timeout_seconds !== undefined
      ? fb.followup_timeout_seconds
      : base.followup_timeout_seconds;

  const profile: ProviderProfile = {
    ...base,
    model: typeof model === 'string' ? model : '',
    temperature: normalizeTemp(temperatureSource),
    system_prompt: typeof promptSource === 'string' && promptSource.trim().length > 0 ? promptSource : DEFAULT_SYSTEM_PROMPT,
    base_url: typeof baseUrlSource === 'string' ? baseUrlSource : '',
    api_key: typeof apiKeySource === 'string' ? apiKeySource : '',
    followup_timeout_seconds: normalizeTimeout(timeoutSource),
  };

  [fb, candidate].forEach((source) => {
    if (!source || typeof source !== 'object') return;
    Object.entries(source).forEach(([key, value]) => {
      if (!KNOWN_PROFILE_FIELDS.has(key)) {
        profile[key] = value;
      }
    });
  });

  return profile;
};

const parseSettingsResponse = (
  data: any,
  providerKeys: string[],
  metaMap: Record<string, ProviderMeta>,
): SettingsState => {
  const rawProfiles = data?.provider_profiles ?? {};
  const keys = providerKeys.length > 0 ? providerKeys : Object.keys(rawProfiles ?? {});
  const resolvedKeys = keys.length > 0 ? keys : FALLBACK_PROVIDER_ORDER;
  const provider = ensureProviderKey(data?.provider, resolvedKeys);
  const enabled = Boolean(data?.enabled);
  const profiles: Record<string, ProviderProfile> = {};
  resolvedKeys.forEach((key) => {
    const source = rawProfiles[key];
    const fallback = provider === key ? data : undefined;
    profiles[key] = hydrateProfile(key, source, fallback, metaMap);
  });
  return { provider, enabled, profiles };
};

const buildPayload = (state: SettingsState, metaMap: Record<string, ProviderMeta>) => {
  const payloadProfiles: Record<string, ProviderProfile> = {};
  Object.entries(state.profiles).forEach(([key, profile]) => {
    const activeProfile = profile ?? defaultProfile(key, metaMap);
    const extras: Record<string, any> = {};
    Object.entries(activeProfile).forEach(([fieldKey, fieldValue]) => {
      if (!KNOWN_PROFILE_FIELDS.has(fieldKey)) {
        extras[fieldKey] = fieldValue;
      }
    });
    payloadProfiles[key] = {
      ...extras,
      model: (activeProfile.model ?? '').trim(),
      temperature: normalizeTemp(activeProfile.temperature),
      system_prompt:
        typeof activeProfile.system_prompt === 'string' && activeProfile.system_prompt.trim().length > 0
          ? activeProfile.system_prompt
          : DEFAULT_SYSTEM_PROMPT,
      base_url: activeProfile.base_url ?? '',
      api_key: activeProfile.api_key ?? '',
      followup_timeout_seconds: normalizeTimeout(activeProfile.followup_timeout_seconds),
    };
  });
  const active = payloadProfiles[state.provider] ?? payloadProfiles[FALLBACK_PROVIDER_ORDER[0]] ?? defaultProfile(state.provider, metaMap);
  return {
    provider: state.provider,
    enabled: state.enabled,
    model: active.model,
    temperature: active.temperature,
    system_prompt: active.system_prompt,
    base_url: active.base_url,
    api_key: active.api_key,
    followup_timeout_seconds: active.followup_timeout_seconds,
    provider_profiles: payloadProfiles,
  };
};

const buildInitialProfiles = (keys: string[], metaMap: Record<string, ProviderMeta>) => {
  return keys.reduce((acc, key) => {
    acc[key] = defaultProfile(key, metaMap);
    return acc;
  }, {} as Record<string, ProviderProfile>);
};

const mergeProviderMetaList = (rawList: any): { meta: Record<string, ProviderMeta>; order: string[] } => {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { meta: { ...FALLBACK_PROVIDER_META }, order: [...FALLBACK_PROVIDER_ORDER] };
  }
  const mergedMeta: Record<string, ProviderMeta> = { ...FALLBACK_PROVIDER_META };
  const order: string[] = [];
  rawList.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const key = typeof item.key === 'string' ? item.key : '';
    if (!key) return;
    const fallback = FALLBACK_PROVIDER_META[key];
    const extraFields = Array.isArray(item.extra_fields)
      ? item.extra_fields.filter((field: any) => field && typeof field.key === 'string')
      : undefined;
    const defaultProfileOverrides = {
      ...(fallback?.default_profile ?? {}),
      ...((item.default_profile as Record<string, any> | undefined) ?? {}),
    };
    mergedMeta[key] = {
      ...fallback,
      ...item,
      default_profile: defaultProfileOverrides,
      extra_fields: extraFields,
    };
    order.push(key);
  });
  FALLBACK_PROVIDER_ORDER.forEach((key) => {
    if (!order.includes(key)) {
      order.push(key);
    }
    if (!mergedMeta[key]) {
      mergedMeta[key] = FALLBACK_PROVIDER_META[key];
    }
  });
  return { meta: mergedMeta, order };
};

/** LLM 設定画面。 */
export default function AdminLlm() {
  const { notify } = useNotify();
  const [providerMeta, setProviderMeta] = useState<Record<string, ProviderMeta>>({ ...FALLBACK_PROVIDER_META });
  const [providerKeys, setProviderKeys] = useState<string[]>([...FALLBACK_PROVIDER_ORDER]);
  const [state, setState] = useState<SettingsState>({
    provider: FALLBACK_PROVIDER_ORDER[0] ?? 'ollama',
    enabled: false,
    profiles: buildInitialProfiles(FALLBACK_PROVIDER_ORDER, FALLBACK_PROVIDER_META),
  });
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(FALLBACK_PROVIDER_ORDER.map((key) => [key, []])),
  );
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const initialLoad = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoSaveNotice = useRef<string | null>(null);

  const activeProvider = state.provider;
  const activeMeta = providerMeta[activeProvider] ?? FALLBACK_PROVIDER_META[activeProvider];
  const currentProfile = state.profiles[activeProvider] ?? defaultProfile(activeProvider, providerMeta);
  const models = modelOptions[activeProvider] ?? [];
  const availableModels = useMemo(() => {
    const trimmed = (currentProfile.model ?? '').trim();
    const merged = trimmed ? [trimmed, ...models] : models;
    return Array.from(new Set(merged));
  }, [currentProfile.model, models]);
  const hasModel = (currentProfile.model ?? '').trim().length > 0;
  const canSave = !state.enabled || hasModel;
  const isEnabled = state.enabled;
  const timeoutSeconds = Number.isFinite(currentProfile.followup_timeout_seconds)
    ? currentProfile.followup_timeout_seconds
    : DEFAULT_FOLLOWUP_TIMEOUT;
  const isGcpProvider = activeProvider === 'gcp_vertex';

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let merged = { meta: { ...FALLBACK_PROVIDER_META }, order: [...FALLBACK_PROVIDER_ORDER] };
      try {
        const providersRes = await fetch('/llm/providers');
        if (providersRes.ok) {
          const providerData = await providersRes.json();
          merged = mergeProviderMetaList(providerData);
        }
      } catch {}

      let parsed: SettingsState | null = null;
      try {
        const res = await fetch('/llm/settings');
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        parsed = parseSettingsResponse(data, merged.order, merged.meta);
      } catch (error) {
        notify({
          title: 'LLM設定の取得に失敗しました',
          status: 'error',
          channel: 'admin',
        });
      }

      if (cancelled) return;
      setProviderMeta(merged.meta);
      setProviderKeys(merged.order);
      if (parsed) {
        setState(parsed);
        setModelOptions(() => {
          const next: Record<string, string[]> = {};
          merged.order.forEach((key) => {
            const modelName = parsed?.profiles[key]?.model?.trim();
            next[key] = modelName ? [modelName] : [];
          });
          return next;
        });
      } else {
        setModelOptions((prev) => {
          const next: Record<string, string[]> = {};
          merged.order.forEach((key) => {
            next[key] = prev[key] ?? [];
          });
          return next;
        });
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  useEffect(() => {
    setModelOptions((prev) => {
      const next: Record<string, string[]> = {};
      providerKeys.forEach((key) => {
        next[key] = prev[key] ?? [];
      });
      return next;
    });
  }, [providerKeys]);

  useEffect(() => {
    setState((prev) => {
      const nextProfiles = { ...prev.profiles };
      let changed = false;
      providerKeys.forEach((key) => {
        if (!nextProfiles[key]) {
          nextProfiles[key] = defaultProfile(key, providerMeta);
          changed = true;
        }
      });
      Object.keys(nextProfiles).forEach((key) => {
        if (!providerKeys.includes(key)) {
          delete nextProfiles[key];
          changed = true;
        }
      });
      const nextProvider = providerKeys.includes(prev.provider) ? prev.provider : providerKeys[0] ?? prev.provider;
      if (changed || nextProvider !== prev.provider) {
        return { provider: nextProvider, enabled: prev.enabled, profiles: nextProfiles };
      }
      return prev;
    });
  }, [providerKeys, providerMeta]);

  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const profile = state.profiles[state.provider] ?? defaultProfile(state.provider, providerMeta);
      if (state.enabled && !(profile.model ?? '').trim()) {
        const message = 'モデル名が未入力のため保存をスキップしました';
        const key = `warning:${message}`;
        if (lastAutoSaveNotice.current !== key) {
          notify({ title: message, status: 'warning', channel: 'admin' });
          lastAutoSaveNotice.current = key;
        }
        return;
      }
      try {
        const payload = buildPayload(state, providerMeta);
        const res = await fetch('/llm/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || 'auto_save_failed');
        }
        lastAutoSaveNotice.current = null;
      } catch (error) {
        const title = 'LLM設定の自動保存に失敗しました';
        const description = error instanceof Error ? error.message : undefined;
        const key = `error:${title}:${description ?? ''}`;
        if (lastAutoSaveNotice.current !== key) {
          notify({ title, description, status: 'error', channel: 'admin' });
          lastAutoSaveNotice.current = key;
        }
      }
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, notify, providerMeta]);

  const updateProfile = (provider: string, updater: (profile: ProviderProfile) => ProviderProfile) => {
    setState((prev) => {
      const prevProfile = prev.profiles[provider] ?? defaultProfile(provider, providerMeta);
      const nextProfile = updater(prevProfile);
      if (prevProfile === nextProfile) return prev;
      return {
        provider: prev.provider,
        enabled: prev.enabled,
        profiles: { ...prev.profiles, [provider]: nextProfile },
      };
    });
  };

  const handleProviderChange = (next: string) => {
    setState((prev) => ({ ...prev, provider: next }));
  };

  const fetchModels = async () => {
    setIsLoadingModels(true);
    const payload = buildPayload(state, providerMeta);
    const trimmedCurrentModel = (payload.model ?? '').trim();
    let nextModel = trimmedCurrentModel;
    let status: FeedbackVariant = 'info';
    const parts: string[] = [];
    try {
      const res = await fetch('/llm/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: payload.provider,
          base_url: payload.base_url,
          api_key: payload.api_key,
          provider_profiles: payload.provider_profiles,
        }),
      });
      if (res.ok) {
        const data: string[] = await res.json();
        const unique = Array.from(new Set((data || []).filter((m) => typeof m === 'string' && m.trim())));
        if (unique.length > 0) {
          setModelOptions((prev) => ({ ...prev, [activeProvider]: unique }));
          parts.push(`${unique.length}件のモデルを読み込みました`);
          status = 'success';
          if (!trimmedCurrentModel || !unique.includes(trimmedCurrentModel)) {
            nextModel = unique[0];
            updateProfile(activeProvider, (profile) => ({ ...profile, model: unique[0] }));
          }
        } else {
          parts.push('モデルが見つかりません');
          status = 'warning';
          setModelOptions((prev) => ({
            ...prev,
            [activeProvider]: trimmedCurrentModel ? [trimmedCurrentModel] : [],
          }));
        }
      } else {
        parts.push('モデルの読み込みに失敗しました');
        status = 'error';
      }
      try {
        const t = await fetch('/llm/settings/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: payload.provider,
            base_url: payload.base_url,
            api_key: payload.api_key,
            model: nextModel,
            enabled: state.enabled,
            provider_profiles: payload.provider_profiles,
          }),
        });
        const detail = await t.json().catch(() => ({}));
        if (detail?.status === 'ok') {
          parts.push('疎通テスト成功');
          if (severityRank[status] < severityRank.success) status = 'success';
        } else {
          parts.push('疎通テスト失敗');
          status = 'error';
        }
      } catch (error) {
        parts.push('疎通テストでエラーが発生しました');
        status = 'error';
      }
      try {
        await refreshLlmStatus();
      } catch {}
    } catch (error) {
      parts.push('モデルの読み込み中にエラーが発生しました');
      status = 'error';
    } finally {
      setIsLoadingModels(false);
      if (parts.length > 0) {
        notify({
          title: 'モデル一覧の更新結果',
          description: parts.join(' / '),
          status,
          channel: 'admin',
        });
      }
    }
  };

  const handleManualTest = async () => {
    try {
      const payload = buildPayload(state, providerMeta);
      const res = await fetch('/llm/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: payload.provider,
          base_url: payload.base_url,
          api_key: payload.api_key,
          model: payload.model,
          enabled: state.enabled,
          provider_profiles: payload.provider_profiles,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.status !== 'ok') {
        throw new Error(data?.detail || 'test_failed');
      }
      notify({ title: '疎通テスト成功', status: 'success', channel: 'admin' });
    } catch (error: any) {
      notify({
        title: '疎通テストに失敗しました',
        description: error?.message || undefined,
        status: 'error',
        channel: 'admin',
      });
    } finally {
      try {
        await refreshLlmStatus();
      } catch {}
    }
  };

  const extraFields = activeMeta?.extra_fields ?? [];
  const showBaseUrl = activeMeta?.use_base_url !== false;
  const showApiKey = activeMeta?.use_api_key !== false;

  const renderExtraField = (field: ProviderFieldMeta) => {
    const fieldKey = field.key;
    const label = field.label ?? fieldKey;
    const type = field.type ?? 'text';
    const helper = field.helper;
    const value = currentProfile[fieldKey];

    const controlProps = {
      key: fieldKey,
      isDisabled: !isEnabled,
      isRequired: field.required,
    };

    if (type === 'textarea') {
      return (
        <FormControl {...controlProps}>
          <FormLabel>{label}</FormLabel>
          <Textarea
            value={typeof value === 'string' ? value : ''}
            onChange={(e) =>
              updateProfile(activeProvider, (profile) => ({ ...profile, [fieldKey]: e.target.value }))
            }
            placeholder={field.placeholder}
            rows={4}
          />
          {helper && <FormHelperText>{helper}</FormHelperText>}
        </FormControl>
      );
    }

    if (type === 'number') {
      const numericValue =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : undefined;
      return (
        <FormControl {...controlProps}>
          <FormLabel>{label}</FormLabel>
          <NumberInput
            value={Number.isFinite(numericValue) ? Number(numericValue) : undefined}
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            onChange={(_, valueAsNumber) =>
              updateProfile(activeProvider, (profile) => ({ ...profile, [fieldKey]: valueAsNumber }))
            }
          >
            <NumberInputField />
            <NumberInputStepper>
              <NumberIncrementStepper />
              <NumberDecrementStepper />
            </NumberInputStepper>
          </NumberInput>
          {helper && <FormHelperText>{helper}</FormHelperText>}
        </FormControl>
      );
    }

    if (type === 'select') {
      const options = field.options ?? [];
      return (
        <FormControl {...controlProps}>
          <FormLabel>{label}</FormLabel>
          <Select
            value={typeof value === 'string' ? value : ''}
            placeholder={field.placeholder}
            onChange={(e) =>
              updateProfile(activeProvider, (profile) => ({ ...profile, [fieldKey]: e.target.value }))
            }
          >
            {options.map((option, index) => {
              const optionValue = option.value ?? option.label ?? '';
              return (
                <option key={`${fieldKey}-${index}`} value={optionValue}>
                  {option.label ?? option.value ?? ''}
                </option>
              );
            })}
          </Select>
          {helper && <FormHelperText>{helper}</FormHelperText>}
        </FormControl>
      );
    }

    if (type === 'password') {
      return (
        <FormControl {...controlProps}>
          <FormLabel>{label}</FormLabel>
          <Input
            type="password"
            autoComplete="new-password"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) =>
              updateProfile(activeProvider, (profile) => ({ ...profile, [fieldKey]: e.target.value }))
            }
            placeholder={field.placeholder}
          />
          {helper && <FormHelperText>{helper}</FormHelperText>}
        </FormControl>
      );
    }

    if (type === 'file') {
      const acceptedTypes = field.accept ?? 'application/json,.json';
      const uploadedLength = typeof value === 'string' ? value.length : 0;
      const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const text = typeof reader.result === 'string' ? reader.result : '';
          updateProfile(activeProvider, (profile) => ({ ...profile, [fieldKey]: text }));
          event.target.value = '';
        };
        reader.onerror = () => {
          notify({
            title: `${label} の読み込みに失敗しました`,
            description: 'ファイルの内容を取得できませんでした。JSON ファイルか確認してください。',
            status: 'error',
            channel: 'admin',
          });
          event.target.value = '';
        };
        reader.readAsText(file);
      };
      const handleClear = () => {
        updateProfile(activeProvider, (profile) => ({ ...profile, [fieldKey]: '' }));
      };
      return (
        <FormControl {...controlProps}>
          <FormLabel>{label}</FormLabel>
          <VStack align="stretch" spacing={2}>
            <Input type="file" accept={acceptedTypes} onChange={handleFileChange} />
            <HStack spacing={3} fontSize="sm" color={uploadedLength > 0 ? 'green.600' : 'gray.500'}>
              <Text>
                {uploadedLength > 0
                  ? `アップロード済み（約 ${uploadedLength.toLocaleString()} 文字）`
                  : '未アップロード'}
              </Text>
              {uploadedLength > 0 && (
                <Button size="xs" variant="ghost" colorScheme="gray" onClick={handleClear}>
                  クリア
                </Button>
              )}
            </HStack>
          </VStack>
          {helper && <FormHelperText>{helper}</FormHelperText>}
        </FormControl>
      );
    }

    return (
      <FormControl {...controlProps}>
        <FormLabel>{label}</FormLabel>
        <Input
          value={typeof value === 'string' ? value : ''}
          onChange={(e) =>
            updateProfile(activeProvider, (profile) => ({ ...profile, [fieldKey]: e.target.value }))
          }
          placeholder={field.placeholder}
        />
        {helper && <FormHelperText>{helper}</FormHelperText>}
      </FormControl>
    );
  };

  return (
    <VStack spacing={6} align="stretch">
      <Card variant="outline">
        <CardHeader>
          <Heading size="md">基本設定</Heading>
          <Text fontSize="sm" color="gray.600" mt={1}>
            LLM の有効化と利用するプロバイダを切り替えます。設定は自動保存されます。
          </Text>
        </CardHeader>
        <CardBody>
          <Stack spacing={5}>
            <FormControl display="flex" alignItems="center">
              <Switch
                colorScheme="primary"
                isChecked={isEnabled}
                onChange={(e) =>
                  setState((prev) => ({ ...prev, enabled: e.target.checked }))
                }
              />
              <FormLabel mb="0" ml={3} fontWeight="semibold">
                LLMを使用する
              </FormLabel>
            </FormControl>
            <Text fontSize="sm" color="gray.600">
              無効のままでも設定は保持されます。テスト実行時のみ疎通確認が行われます。
            </Text>
            <FormControl>
              <FormLabel>LLM プロバイダ</FormLabel>
              <Select
                value={activeProvider}
                onChange={(e) => handleProviderChange(ensureProviderKey(e.target.value, providerKeys))}
              >
                {providerKeys.map((key) => (
                  <option key={key} value={key}>
                    {providerMeta[key]?.label ?? FALLBACK_PROVIDER_META[key]?.label ?? key}
                  </option>
                ))}
              </Select>
              <FormHelperText>{activeMeta?.description}</FormHelperText>
            </FormControl>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outline">
        <CardHeader>
          <Heading size="md">接続情報</Heading>
          <Text fontSize="sm" color="gray.600" mt={1}>
            ベースURLと API キーはプロバイダごとに保存されます。
          </Text>
        </CardHeader>
        <CardBody>
          <Stack spacing={4}>
            {showBaseUrl && (
              <FormControl isDisabled={!isEnabled}>
                <FormLabel>ベースURL（任意）</FormLabel>
                <Input
                  placeholder={`例: ${resolveDefaultBaseUrl(activeProvider, providerMeta)}`}
                  value={currentProfile.base_url ?? ''}
                  onChange={(e) =>
                    updateProfile(activeProvider, (profile) => ({ ...profile, base_url: e.target.value }))
                  }
                />
                {activeMeta?.helper && <FormHelperText>{activeMeta.helper}</FormHelperText>}
              </FormControl>
            )}
            {showApiKey && (
              <FormControl isDisabled={!isEnabled}>
                <FormLabel>APIキー（任意）</FormLabel>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={currentProfile.api_key ?? ''}
                  onChange={(e) =>
                    updateProfile(activeProvider, (profile) => ({ ...profile, api_key: e.target.value }))
                  }
                />
              </FormControl>
            )}
            {extraFields.map((field) => renderExtraField(field))}
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outline">
        <CardHeader>
          <Heading size="md">モデル設定</Heading>
          <Text fontSize="sm" color="gray.600" mt={1}>
            利用したいモデル名や推論パラメータ、システムプロンプトを設定します。
          </Text>
        </CardHeader>
        <CardBody>
          <Stack spacing={5}>
            <FormControl isDisabled={!isEnabled} isInvalid={state.enabled && !canSave}>
              <Stack
                direction={{ base: 'column', md: 'row' }}
                justify="space-between"
                align={{ base: 'stretch', md: 'center' }}
                spacing={{ base: 3, md: 4 }}
                mb={3}
              >
                <Stack direction={{ base: 'column', md: 'row' }} spacing={3} align="center">
                  <Text fontWeight="semibold">モデル名</Text>
                  <Input
                    value={currentProfile.model ?? ''}
                    onChange={(e) =>
                      updateProfile(activeProvider, (profile) => ({ ...profile, model: e.target.value }))
                    }
                    placeholder="例: gpt-3.5-turbo"
                  />
                </Stack>
                <Stack direction="row" spacing={2} justify="flex-end">
                  {!isGcpProvider && (
                    <Button
                      size="sm"
                      leftIcon={<RepeatIcon />}
                      onClick={fetchModels}
                      isLoading={isLoadingModels}
                      loadingText="取得中"
                      variant="outline"
                    >
                      使用可能なモデル一覧を取得
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleManualTest}
                    isDisabled={!isEnabled}
                  >
                    疎通テストを実行
                  </Button>
                </Stack>
              </Stack>
              {!isGcpProvider ? (
                <>
                  <Select
                    id="llm-model-select"
                    value={currentProfile.model ?? ''}
                    placeholder="使用可能なモデル一覧を取得してください"
                    onChange={(e) =>
                      updateProfile(activeProvider, (profile) => ({ ...profile, model: e.target.value }))
                    }
                    isDisabled={!isEnabled || availableModels.length === 0}
                  >
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </Select>
                  {isLoadingModels && (
                    <HStack mt={2} color="gray.600" fontSize="sm">
                      <Spinner size="sm" />
                      <Text>モデル一覧を取得中です…</Text>
                    </HStack>
                  )}
                  <FormHelperText>
                    「使用可能なモデル一覧を取得」を押すと候補が更新されます。保存済みのモデル名は一覧取得前でも表示されます。
                  </FormHelperText>
                </>
              ) : (
                <FormHelperText>
                  Google Cloud Vertex AI ではモデルを直接入力し、「疎通テストを実行」で接続可否を確認してください。
                </FormHelperText>
              )}
              {!canSave && (
                <Text color="red.500" fontSize="sm" mt={2}>
                  LLM有効時はモデル名が必須です
                </Text>
              )}
            </FormControl>

            <FormControl isDisabled={!isEnabled}>
              <FormLabel>temperature</FormLabel>
              <HStack>
                <Slider
                  min={0}
                  max={2}
                  step={0.1}
                  value={Number.isFinite(currentProfile.temperature) ? currentProfile.temperature : 0.2}
                  onChange={(val) =>
                    updateProfile(activeProvider, (profile) => ({ ...profile, temperature: normalizeTemp(val) }))
                  }
                  flex={1}
                >
                  <SliderTrack>
                    <SliderFilledTrack />
                  </SliderTrack>
                  <SliderThumb />
                </Slider>
                <Text width="48px" textAlign="right">
                  {(Number.isFinite(currentProfile.temperature) ? currentProfile.temperature : 0.2).toFixed(1)}
                </Text>
              </HStack>
              <FormHelperText>0.0〜2.0 の範囲で出力のランダム性を調整します。</FormHelperText>
            </FormControl>

            <FormControl isDisabled={!isEnabled}>
              <FormLabel>追加質問タイムアウト（秒）</FormLabel>
              <NumberInput
                min={5}
                max={120}
                step={5}
                value={timeoutSeconds}
                onChange={(_, valueAsNumber) =>
                  updateProfile(activeProvider, (profile) => ({
                    ...profile,
                    followup_timeout_seconds: normalizeTimeout(valueAsNumber),
                  }))
                }
              >
                <NumberInputField />
                <NumberInputStepper>
                  <NumberIncrementStepper />
                  <NumberDecrementStepper />
                </NumberInputStepper>
              </NumberInput>
              <FormHelperText>LLM 追質問生成のリクエストが失敗とみなされるまでの待機時間です。</FormHelperText>
            </FormControl>

            <FormControl isDisabled={!isEnabled}>
              <FormLabel>システムプロンプト</FormLabel>
              <Textarea
                value={currentProfile.system_prompt}
                onChange={(e) =>
                  updateProfile(activeProvider, (profile) => ({ ...profile, system_prompt: e.target.value }))
                }
                rows={6}
              />
            </FormControl>
          </Stack>
        </CardBody>
      </Card>

      <AutoTestOnUnmount />
    </VStack>
  );
}

// 画面離脱時に疎通テストを実行し、ヘッダのLLM状態を更新する
function AutoTestOnUnmount() {
  useEffect(() => {
    return () => {
      fetch('/llm/settings/test', { method: 'POST' }).finally(() => {
        refreshLlmStatus().catch(() => {});
      });
    };
  }, []);
  return null;
}
