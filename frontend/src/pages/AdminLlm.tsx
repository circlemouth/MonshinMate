import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Button,
  ButtonGroup,
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
  Stack,
  Switch,
  Text,
  Textarea,
  useToast,
  VStack,
  Spinner,
} from '@chakra-ui/react';
import { RepeatIcon } from '@chakra-ui/icons';
import { refreshLlmStatus } from '../utils/llmStatus';

type FeedbackVariant = 'info' | 'success' | 'warning' | 'error';

const PROVIDER_KEYS = ['ollama', 'lm_studio', 'openai'] as const;
type ProviderKey = (typeof PROVIDER_KEYS)[number];

const DEFAULT_SYSTEM_PROMPT =
  'あなたは日本語で応答する熟練した医療問診支援AIです。患者の入力を理解し、医学的に適切で簡潔な回答や質問を行ってください。不要な前置きや断り書きは避け、常に敬体で表現してください。';

interface ProviderProfile {
  model: string;
  temperature: number;
  system_prompt: string;
  base_url: string;
  api_key: string;
}

interface SettingsState {
  provider: ProviderKey;
  enabled: boolean;
  profiles: Record<ProviderKey, ProviderProfile>;
}

type FeedbackState = { status: FeedbackVariant; message: string } | null;

const PROVIDER_META: Record<ProviderKey, { label: string; description: string; helper: string }> = {
  ollama: {
    label: 'Ollama',
    description: 'ローカルで稼働する Ollama サーバー向けの設定です。',
    helper: 'ベースURLが空の場合は http://localhost:11434 を使用します。',
  },
  lm_studio: {
    label: 'LM Studio',
    description: 'LM Studio のWebサーバーへ接続してモデルを利用します。',
    helper: 'LM Studio の Web UI に表示されるエンドポイントURLを入力してください。',
  },
  openai: {
    label: 'OpenAI (互換API含む)',
    description: 'OpenAI / Azure OpenAI / 互換API サービスを利用します。',
    helper: 'ベースURLに https://api.openai.com 等を設定し、APIキーを入力してください。',
  },
};

const normalizeTemp = (val: unknown): number => {
  const num = typeof val === 'number' ? val : parseFloat(String(val ?? ''));
  if (!Number.isFinite(num)) return 0.2;
  return Math.min(2, Math.max(0, num));
};

const defaultBaseUrl = (provider: ProviderKey): string => {
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

const defaultProfile = (provider: ProviderKey): ProviderProfile => ({
  model: '',
  temperature: 0.2,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  base_url: defaultBaseUrl(provider),
  api_key: '',
});

const ensureProviderKey = (value: unknown): ProviderKey => {
  if (PROVIDER_KEYS.includes(value as ProviderKey)) {
    return value as ProviderKey;
  }
  return 'ollama';
};

const hydrateProfile = (provider: ProviderKey, raw: any, fallback: any): ProviderProfile => {
  const candidate = raw ?? {};
  const fb = fallback ?? {};
  const baseUrl =
    candidate.base_url !== undefined
      ? candidate.base_url ?? ''
      : fb.base_url !== undefined
      ? fb.base_url ?? ''
      : defaultBaseUrl(provider);
  const apiKey =
    candidate.api_key !== undefined
      ? candidate.api_key ?? ''
      : typeof fb.api_key === 'string'
      ? fb.api_key
      : '';
  const systemPromptSource =
    candidate.system_prompt !== undefined ? candidate.system_prompt : fb.system_prompt;
  const resolvedPrompt =
    typeof systemPromptSource === 'string' && systemPromptSource.trim().length > 0
      ? systemPromptSource
      : DEFAULT_SYSTEM_PROMPT;

  return {
    model: typeof (candidate.model ?? fb.model) === 'string' ? candidate.model ?? fb.model ?? '' : '',
    temperature: normalizeTemp(candidate.temperature ?? fb.temperature ?? 0.2),
    system_prompt: resolvedPrompt,
    base_url: baseUrl,
    api_key: typeof apiKey === 'string' ? apiKey : '',
  };
};

const parseSettingsResponse = (data: any): SettingsState => {
  const provider = ensureProviderKey(data?.provider);
  const enabled = Boolean(data?.enabled);
  const rawProfiles = data?.provider_profiles ?? {};
  const profiles = {} as Record<ProviderKey, ProviderProfile>;
  for (const key of PROVIDER_KEYS) {
    const source = rawProfiles[key];
    const profile = hydrateProfile(key, source, key === provider ? data : undefined);
    profiles[key] = profile;
  }
  return { provider, enabled, profiles };
};

const buildPayload = (state: SettingsState) => {
  const payloadProfiles: Record<string, ProviderProfile> = {};
  for (const key of PROVIDER_KEYS) {
    const profile = state.profiles[key] ?? defaultProfile(key);
    payloadProfiles[key] = {
      model: profile.model,
      temperature: normalizeTemp(profile.temperature),
      system_prompt: profile.system_prompt,
      base_url: profile.base_url ?? '',
      api_key: profile.api_key ?? '',
    };
  }
  const active = payloadProfiles[state.provider] ?? defaultProfile(state.provider);
  return {
    provider: state.provider,
    enabled: state.enabled,
    model: active.model,
    temperature: active.temperature,
    system_prompt: active.system_prompt,
    base_url: active.base_url,
    api_key: active.api_key,
    provider_profiles: payloadProfiles,
  };
};

const severityRank: Record<FeedbackVariant, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
};

/** LLM 設定画面。 */
export default function AdminLlm() {
  const initialProfiles = PROVIDER_KEYS.reduce(
    (acc, key) => ({ ...acc, [key]: defaultProfile(key) }),
    {} as Record<ProviderKey, ProviderProfile>,
  );
  const [state, setState] = useState<SettingsState>({ provider: 'ollama', enabled: false, profiles: initialProfiles });
  const [modelOptions, setModelOptions] = useState<Record<ProviderKey, string[]>>({
    ollama: [],
    lm_studio: [],
    openai: [],
  });
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const toast = useToast();
  const initialLoad = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeProvider = state.provider;
  const currentProfile = state.profiles[activeProvider] ?? defaultProfile(activeProvider);
  const models = modelOptions[activeProvider] ?? [];
  const availableModels = useMemo(() => {
    const trimmed = (currentProfile.model ?? '').trim();
    const merged = trimmed ? [trimmed, ...models] : models;
    return Array.from(new Set(merged));
  }, [currentProfile.model, models]);
  const hasModel = (currentProfile.model ?? '').trim().length > 0;
  const canSave = !state.enabled || hasModel;
  const isEnabled = state.enabled;

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/llm/settings');
        if (!res.ok) throw new Error('failed to load');
        const data = await res.json();
        const parsed = parseSettingsResponse(data);
        setState(parsed);
        setModelOptions(() => {
          const next: Record<ProviderKey, string[]> = {
            ollama: [],
            lm_studio: [],
            openai: [],
          };
          for (const key of PROVIDER_KEYS) {
            const modelName = parsed.profiles[key]?.model?.trim();
            next[key] = modelName ? [modelName] : [];
          }
          return next;
        });
      } catch (error) {
        setFeedback({ status: 'error', message: 'LLM設定の取得に失敗しました' });
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const profile = state.profiles[state.provider] ?? defaultProfile(state.provider);
      if (state.enabled && !(profile.model ?? '').trim()) {
        setFeedback({ status: 'warning', message: 'モデル名が未入力のため保存をスキップしました' });
        return;
      }
      try {
        const payload = buildPayload(state);
        const res = await fetch('/llm/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || 'auto_save_failed');
        }
        setFeedback({ status: 'success', message: '自動保存しました' });
      } catch (error) {
        setFeedback({ status: 'error', message: '自動保存に失敗しました' });
      }
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state]);

  const updateProfile = (provider: ProviderKey, updater: (profile: ProviderProfile) => ProviderProfile) => {
    setState((prev) => {
      const prevProfile = prev.profiles[provider] ?? defaultProfile(provider);
      const nextProfile = updater(prevProfile);
      if (prevProfile === nextProfile) return prev;
      return {
        provider: prev.provider,
        enabled: prev.enabled,
        profiles: { ...prev.profiles, [provider]: nextProfile },
      };
    });
  };

  const handleProviderChange = (next: ProviderKey) => {
    setState((prev) => ({ ...prev, provider: next }));
  };

  const fetchModels = async () => {
    setIsLoadingModels(true);
    setFeedback(null);
    const trimmedCurrentModel = (currentProfile.model ?? '').trim();
    let nextModel = trimmedCurrentModel;
    let status: FeedbackVariant = 'info';
    const parts: string[] = [];
    try {
      const res = await fetch('/llm/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: activeProvider,
          base_url: currentProfile.base_url,
          api_key: currentProfile.api_key,
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
        const testTarget = {
          ...currentProfile,
          model: nextModel,
        };
        const t = await fetch('/llm/settings/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: activeProvider,
            base_url: testTarget.base_url,
            api_key: testTarget.api_key,
            model: testTarget.model,
            enabled: state.enabled,
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
        setFeedback({ status, message: parts.join(' / ') });
      }
    }
  };

  const handleManualTest = async () => {
    setFeedback(null);
    try {
      const res = await fetch('/llm/settings/test', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.status !== 'ok') {
        throw new Error(data?.detail || 'test_failed');
      }
      toast({ title: '疎通テスト成功', status: 'success' });
      setFeedback({ status: 'success', message: '疎通テストが成功しました' });
    } catch (error: any) {
      toast({ title: '疎通テストに失敗しました', description: error?.message || '', status: 'error' });
      setFeedback({ status: 'error', message: '疎通テストに失敗しました' });
    } finally {
      try {
        await refreshLlmStatus();
      } catch {}
    }
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
                onChange={(e) => handleProviderChange(ensureProviderKey(e.target.value))}
              >
                {PROVIDER_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {PROVIDER_META[key].label}
                  </option>
                ))}
              </Select>
              <FormHelperText>{PROVIDER_META[activeProvider].description}</FormHelperText>
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
            <FormControl isDisabled={!isEnabled}>
              <FormLabel>ベースURL（任意）</FormLabel>
              <Input
                placeholder={`例: ${defaultBaseUrl(activeProvider)}`}
                value={currentProfile.base_url ?? ''}
                onChange={(e) =>
                  updateProfile(activeProvider, (profile) => ({ ...profile, base_url: e.target.value }))
                }
              />
              <FormHelperText>{PROVIDER_META[activeProvider].helper}</FormHelperText>
            </FormControl>
            <FormControl isDisabled={!isEnabled}>
              <FormLabel>APIキー（任意）</FormLabel>
              <Input
                type="password"
                value={currentProfile.api_key ?? ''}
                onChange={(e) =>
                  updateProfile(activeProvider, (profile) => ({ ...profile, api_key: e.target.value }))
                }
              />
            </FormControl>
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
              <HStack justify="space-between" align="center" mb={2}>
                <FormLabel m={0}>モデル名</FormLabel>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={fetchModels}
                  isLoading={isLoadingModels}
                  isDisabled={!isEnabled}
                  leftIcon={<RepeatIcon />}
                >
                  使用可能なモデル一覧を取得
                </Button>
              </HStack>
              <Select
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
                  {(
                    Number.isFinite(currentProfile.temperature) ? currentProfile.temperature : 0.2
                  ).toFixed(1)}
                </Text>
              </HStack>
              <FormHelperText>0.0〜2.0 の範囲で出力のランダム性を調整します。</FormHelperText>
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

      <Card variant="outline">
        <CardHeader>
          <Heading size="md">動作確認</Heading>
          <Text fontSize="sm" color="gray.600" mt={1}>
            モデル一覧の取得や疎通テストで接続状態を確認します。
          </Text>
        </CardHeader>
      <CardBody>
        <Stack spacing={4}>
          <ButtonGroup>
            <Button variant="outline" onClick={handleManualTest} isDisabled={!isEnabled}>
              疎通テストを実行
            </Button>
          </ButtonGroup>
          {feedback && (
            <Alert status={feedback.status} variant="subtle">
              <AlertIcon />
              <Text>{feedback.message}</Text>
            </Alert>
            )}
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
