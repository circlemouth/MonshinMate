import { useEffect, useState } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Select,
  NumberInput,
  NumberInputField,
  Textarea,
  Button,
  HStack,
  Switch,
  Text,
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';

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
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
      return;
    }
    fetch('/llm/settings')
      .then((res) => res.json())
      .then((data) => setSettings({
        provider: data.provider ?? 'ollama',
        model: data.model ?? '',
        temperature: data.temperature ?? 0.2,
        system_prompt: data.system_prompt ?? '',
        enabled: data.enabled ?? true,
        base_url: data.base_url ?? '',
        api_key: data.api_key ?? '',
      }));
  }, [navigate]);

  return (
    <VStack spacing={4} align="stretch">
      <FormControl>
        <FormLabel>LLM プロバイダ</FormLabel>
        <Select
          value={settings.provider}
          onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
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
        <FormLabel>モデル名</FormLabel>
        <Input
          value={settings.model}
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
        />
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
      <FormControl>
        <FormLabel>temperature</FormLabel>
        <NumberInput
          value={settings.temperature}
          onChange={(_, val) => setSettings({ ...settings, temperature: val })}
          min={0}
          max={2}
          step={0.1}
        >
          <NumberInputField />
        </NumberInput>
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
          onClick={() =>
            fetch('/llm/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings),
            }).then(() => setTestResult('保存しました'))
          }
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
