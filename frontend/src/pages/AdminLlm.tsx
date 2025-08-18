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
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';

interface Settings {
  provider: string;
  model: string;
  temperature: number;
  system_prompt: string;
}

/** LLM 設定画面。 */
export default function AdminLlm() {
  const [settings, setSettings] = useState<Settings>({
    provider: 'ollama',
    model: '',
    temperature: 0.2,
    system_prompt: '',
  });
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
      return;
    }
    fetch('/llm/settings')
      .then((res) => res.json())
      .then((data) => setSettings(data));
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
        <FormLabel>モデル名</FormLabel>
        <Input
          value={settings.model}
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
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
      <Button
        onClick={() =>
          fetch('/llm/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
          })
        }
        colorScheme="green"
      >
        LLM設定を保存
      </Button>
    </VStack>
  );
}
