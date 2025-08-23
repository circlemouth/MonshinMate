import { useEffect, useState } from 'react';
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
  Switch,
  Text,
  Spinner,
} from '@chakra-ui/react';

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
  const [settings, setSettings] = useState<Settings>({
    provider: 'ollama',
    model: '',
    temperature: 0.2,
    system_prompt: '',
    enabled: true,
    base_url: '',
    api_key: '',
  });
  const [testResult, setTestResult] = useState<string>('');
  const [models, setModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  useEffect(() => {
    fetch('/llm/settings')
      .then((res) => res.json())
      .then((data) => {
        const loaded = {
          provider: data.provider ?? 'ollama',
          model: data.model ?? '',
          temperature: normalizeTemp(data.temperature ?? 0.2),
          system_prompt: data.system_prompt ?? '',
          enabled: data.enabled ?? true,
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

  const fetchModels = async () => {
    setIsLoadingModels(true);
    setTestResult('');
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
        const data = await res.json();
        setModels(data);
        if (data.length > 0) {
          setTestResult(`${data.length}件のモデルを読み込みました`);
          // 現在のモデルが一覧にない場合は、先頭のモデルを選択
          if (settings.model && !data.includes(settings.model)) {
            setSettings({ ...settings, model: data[0] });
          }
        } else {
          setTestResult('モデルが見つかりません');
        }
      } else {
        setTestResult('モデルの読み込みに失敗しました');
      }
    } catch (error) {
      setTestResult('モデルの読み込み中にエラーが発生しました');
    } finally {
      setIsLoadingModels(false);
    }
  };

  return (
    <VStack spacing={4} align="stretch">
      <FormControl>
        <FormLabel>LLM プロバイダ</FormLabel>
        <Select
          value={settings.provider}
          onChange={(e) => setSettings({ ...settings, provider: e.target.value, model: '' })}
        >
          <option value="ollama">Ollama</option>
          <option value="lm_studio">LM Studio</option>
        </Select>
      </FormControl>
      <FormControl>
        <HStack>
          <Switch
            isChecked={settings.enabled}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
          />
          <Text>LLM を有効化</Text>
        </HStack>
      </FormControl>
      <FormControl>
        <FormLabel>ベースURL（任意・リモート接続時）</FormLabel>
        <Input
          placeholder="例: http://server:11434"
          value={settings.base_url ?? ''}
          onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
        />
      </FormControl>
      <FormControl>
        <FormLabel>APIキー（任意）</FormLabel>
        <Input
          type="password"
          value={settings.api_key ?? ''}
          onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
        />
      </FormControl>

      <HStack>
        <Button onClick={fetchModels} isLoading={isLoadingModels}>
          使用可能なモデル一覧を取得
        </Button>
        {isLoadingModels && <Spinner size="sm" />}
      </HStack>

      <FormControl>
        <FormLabel>モデル名</FormLabel>
        <Select
          value={settings.model}
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
          placeholder={models.length === 0 ? '先にモデル一覧を取得してください' : 'モデルを選択'}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </FormControl>

      <FormControl>
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
      <FormControl>
        <FormLabel>システムプロンプト</FormLabel>
        <Textarea
          value={settings.system_prompt}
          onChange={(e) => setSettings({ ...settings, system_prompt: e.target.value })}
        />
      </FormControl>
      <HStack>
        <Button
          onClick={async () => {
            setTestResult('');
            try {
              const res = await fetch('/llm/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
              });
              if (!res.ok) throw new Error('save_failed');
              // 保存後に再取得してUIへ確実に反映
              const re = await fetch('/llm/settings');
              if (re.ok) {
                const data = await re.json();
                setSettings({
                  provider: data.provider ?? 'ollama',
                  model: data.model ?? '',
                  temperature: normalizeTemp(data.temperature ?? 0.2),
                  system_prompt: data.system_prompt ?? '',
                  enabled: data.enabled ?? true,
                  base_url: data.base_url ?? '',
                  api_key: data.api_key ?? '',
                });
                if (data.model) {
                  setModels((prev) => (prev.includes(data.model) ? prev : [data.model, ...prev]));
                }
              }
              setTestResult('保存しました');
            } catch (e) {
              setTestResult('保存に失敗しました');
            }
          }}
          colorScheme="primary"
        >
          LLM設定を保存
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            fetch('/llm/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings),
            })
              .then(() => fetch('/llm/settings/test', { method: 'POST' }))
              .then((r) => r.json())
              .then((res) => setTestResult(res.status === 'ok' ? '疎通OK' : `疎通NG: ${res.detail ?? ''}`))
          }
        >
          疎通テスト
        </Button>
        <Text>{testResult}</Text>
      </HStack>
    </VStack>
  );
}
