import { useEffect, useRef, useState } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Select,
  Slider,
  SliderTrack,
  SliderFilledTrack,
  SliderThumb,
  Textarea,
  Button,
  HStack,
  Checkbox,
  Text,
  Spinner,
  useToast,
} from '@chakra-ui/react';
import { refreshLlmStatus } from '../utils/llmStatus';

interface Settings {
  provider: string;
  model: string;
  temperature: number;
  system_prompt: string;
  enabled: boolean;
  base_url?: string | null;
  api_key?: string | null;
}

/** LLM 設定画面。 */
export default function AdminLlm() {
  // temperature の正規化（0〜2の範囲、NaN は 0.2 にフォールバック）
  const normalizeTemp = (val: any): number => {
    const n = typeof val === 'number' ? val : parseFloat(val);
    if (!Number.isFinite(n)) return 0.2;
    return Math.min(2, Math.max(0, n));
  };
  const defaultBaseUrl = (provider: string): string => {
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
  const [settings, setSettings] = useState<Settings>({
    provider: 'ollama',
    model: '',
    temperature: 0.2,
    system_prompt: '',
    enabled: false, // 既定は「LLMを使用しない」
    // 初期表示はバックエンド既定（Ollama: 11434）に合わせる
    base_url: defaultBaseUrl('ollama'),
    api_key: '',
  });
  const [message, setMessage] = useState<string>('');
  const toast = useToast();
  const [models, setModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const canSave = !settings.enabled || !!(settings.model && settings.model.trim());
  const initialLoad = useRef(true);
  const saveTimer = useRef<any>(null);

  useEffect(() => {
    fetch('/llm/settings')
      .then((res) => res.json())
      .then((data) => {
        const loaded = {
          provider: data.provider ?? 'ollama',
          model: data.model ?? '',
          temperature: normalizeTemp(data.temperature ?? 0.2),
          system_prompt: data.system_prompt ?? '',
          enabled: data.enabled ?? false, // 値が無い場合も未使用を既定に
          base_url: data.base_url ?? '',
          api_key: data.api_key ?? '',
        } as Settings;
        setSettings(loaded);
        // 保存済みのモデル名がある場合、モデル一覧が空でも選択肢に含めて表示できるようにする
        if (loaded.model) {
          setModels((prev) => (prev.includes(loaded.model) ? prev : [loaded.model, ...prev]));
        }
      });
  }, []);

  // 入力変更を自動保存（500ms デバウンス、初期ロード直後はスキップ）
  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      // 有効時はモデル名必須。未入力なら保存しない。
      if (settings.enabled && !canSave) return;
      try {
        const res = await fetch('/llm/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || 'auto_save_failed');
        }
        setMessage('自動保存しました');
      } catch (e: any) {
        // 自動保存の失敗はトーストを抑制し、画面下のメッセージのみ
        setMessage('自動保存に失敗しました');
      }
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const fetchModels = async () => {
    setIsLoadingModels(true);
    setMessage('');
    let nextModel = settings.model;
    try {
      const res = await fetch('/llm/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: settings.provider,
          base_url: settings.base_url,
          api_key: settings.api_key,
        }),
      });
      if (res.ok) {
        const data: string[] = await res.json();
        const unique = Array.from(new Set((data || []).filter((m) => typeof m === 'string' && m.trim())));
        const suggestions = settings.model && !unique.includes(settings.model)
          ? [settings.model, ...unique]
          : unique;
        setModels(suggestions);
        if (unique.length > 0) {
          setMessage(`${unique.length}件のモデルを読み込みました`);
          if (!settings.model) {
            nextModel = unique[0];
            setSettings((prev) => ({ ...prev, model: nextModel }));
          }
        } else {
          setMessage('モデルが見つかりません');
        }
      } else {
        setMessage('モデルの読み込みに失敗しました');
      }
      try {
        const t = await fetch('/llm/settings/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: settings.provider,
            base_url: settings.base_url,
            api_key: settings.api_key,
            model: nextModel,
            enabled: settings.enabled,
          }),
        });
        const d = await t.json().catch(() => ({}));
        setMessage((prev) =>
          d.status === 'ok'
            ? `${prev} / 疎通テスト成功`
            : `${prev} / 疎通テスト失敗`
        );
      } catch {
        setMessage((prev) => `${prev} / 疎通テストでエラー`);
      } finally {
        try {
          await refreshLlmStatus();
        } catch {}
      }
    } catch (error) {
      setMessage('モデルの読み込み中にエラーが発生しました');
    } finally {
      setIsLoadingModels(false);
    }
  };

  return (
    <VStack spacing={4} align="stretch">
      <FormControl>
        <Checkbox
          isChecked={settings.enabled}
          onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
        >
          LLMを使用する
        </Checkbox>
      </FormControl>
      {settings.enabled && (
        <FormControl>
          <FormLabel>LLM プロバイダ</FormLabel>
          <Select
            value={settings.provider}
            onChange={(e) => {
              const next = e.target.value;
              setSettings((prev) => {
                const shouldSetDefault = !prev.base_url || prev.base_url === defaultBaseUrl(prev.provider);
                return {
                  ...prev,
                  provider: next,
                  model: '',
                  base_url: shouldSetDefault ? defaultBaseUrl(next) : prev.base_url,
                };
              });
              setModels([]);
            }}
          >
            <option value="ollama">Ollama</option>
            <option value="lm_studio">LM Studio</option>
            <option value="openai">OpenAI (互換API含む)</option>
          </Select>
        </FormControl>
      )}
      <FormControl isDisabled={!settings.enabled}>
        <FormLabel>ベースURL（任意・リモート接続時）</FormLabel>
        <Input
          placeholder={`例: ${defaultBaseUrl(settings.provider)}`}
          value={settings.base_url ?? ''}
          onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
        />
      </FormControl>
      <FormControl isDisabled={!settings.enabled}>
        <FormLabel>APIキー（任意）</FormLabel>
        <Input
          type="password"
          value={settings.api_key ?? ''}
          onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
        />
      </FormControl>

      <HStack>
        <Button onClick={fetchModels} isLoading={isLoadingModels} isDisabled={!settings.enabled}>
          使用可能なモデル一覧を取得
        </Button>
        {isLoadingModels && <Spinner size="sm" />}
      </HStack>

      <FormControl isDisabled={!settings.enabled} isInvalid={settings.enabled && !canSave}>
        <FormLabel>モデル名</FormLabel>
        <Input
          list="llm-model-suggestions"
          value={settings.model}
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
          placeholder={models.length === 0 ? 'モデル名を直接入力するか、一覧を取得してください' : 'モデル名を入力または選択'}
        />
        <datalist id="llm-model-suggestions">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {settings.enabled && !canSave && (
          <Text color="red.500" fontSize="sm" mt={1}>LLM有効時はモデル名が必須です</Text>
        )}
      </FormControl>

      <FormControl isDisabled={!settings.enabled}>
        <FormLabel>temperature</FormLabel>
        {/* スライダー形式（0.0〜2.0 を 0.1 刻み） */}
        <HStack>
          <Slider
            min={0}
            max={2}
            step={0.1}
            value={Number.isFinite(settings.temperature) ? settings.temperature : 0.2}
            onChange={(val) => setSettings({ ...settings, temperature: normalizeTemp(val) })}
            flex={1}
          >
            <SliderTrack>
              <SliderFilledTrack />
            </SliderTrack>
            <SliderThumb />
          </Slider>
          <Text width="48px" textAlign="right">{(Number.isFinite(settings.temperature) ? settings.temperature : 0.2).toFixed(1)}</Text>
        </HStack>
      </FormControl>
      <FormControl isDisabled={!settings.enabled}>
        <FormLabel>システムプロンプト</FormLabel>
        <Textarea
          value={settings.system_prompt}
          onChange={(e) => setSettings({ ...settings, system_prompt: e.target.value })}
        />
      </FormControl>
      <HStack>
        <Button
          colorScheme="primary"
          isDisabled={!settings.enabled}
          onClick={async () => {
            setMessage('');
            try {
              // 手動で疎通テスト
              const r = await fetch('/llm/settings/test', { method: 'POST' });
              const d = await r.json().catch(() => ({}));
              if (!r.ok || d?.status !== 'ok') {
                throw new Error(d?.detail || 'test_failed');
              }
              toast({ title: '疎通テスト成功', status: 'success' });
            } catch (e: any) {
              toast({ title: '疎通テストに失敗しました', description: e?.message || '', status: 'error' });
            } finally {
              // ヘッダのバッジ更新
              try { await refreshLlmStatus(); } catch {}
            }
          }}
        >
          疎通テストを実行
        </Button>
        <Text>{message}</Text>
      </HStack>

      {/* 画面離脱時に疎通テスト＋ステータス更新を実施 */}
      <AutoTestOnUnmount />
    </VStack>
  );
}

// 画面離脱時に疎通テストを実行し、ヘッダのLLM状態を更新する
function AutoTestOnUnmount() {
  useEffect(() => {
    return () => {
      // 非同期で発火（結果はバッジ更新に反映）
      fetch('/llm/settings/test', { method: 'POST' }).finally(() => {
        refreshLlmStatus().catch(() => {});
      });
    };
  }, []);
  return null;
}
