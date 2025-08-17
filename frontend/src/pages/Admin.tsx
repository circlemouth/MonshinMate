import { useEffect, useState } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
  Select,
  NumberInput,
  NumberInputField,
  Textarea,
  Box,
} from '@chakra-ui/react';

interface Item {
  id: string;
  label: string;
  type: string;
  required: boolean;
}

/** 管理用の問診テンプレート編集画面（スタブ）。 */
export default function Admin() {
  const [items, setItems] = useState<Item[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [settings, setSettings] = useState({
    provider: 'ollama',
    model: '',
    temperature: 0.2,
    system_prompt: '',
  });

  useEffect(() => {
    fetch('/questionnaires/default/template?visit_type=initial')
      .then((res) => res.json())
      .then((data) => setItems(data.items));
    fetch('/llm/settings')
      .then((res) => res.json())
      .then((data) => setSettings(data));
  }, []);

  const addItem = () => {
    setItems([
      ...items,
      { id: `item${items.length + 1}`, label: newLabel, type: 'string', required: false },
    ]);
    setNewLabel('');
  };

  return (
    <VStack spacing={4} align="stretch">
      <Table size="sm">
        <Thead>
          <Tr>
            <Th>ID</Th>
            <Th>ラベル</Th>
          </Tr>
        </Thead>
        <Tbody>
          {items.map((item) => (
            <Tr key={item.id}>
              <Td>{item.id}</Td>
              <Td>{item.label}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
      <FormControl>
        <FormLabel>新規項目ラベル</FormLabel>
        <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
      </FormControl>
      <Button onClick={addItem} colorScheme="blue">
        追加（ローカル）
      </Button>
      <Box borderWidth="1px" borderRadius="md" p={4} w="100%">
        <VStack spacing={4} align="stretch">
          <FormControl>
            <FormLabel>LLM プロバイダ</FormLabel>
            <Select
              value={settings.provider}
              onChange={(e) =>
                setSettings({ ...settings, provider: e.target.value })
              }
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
              onChange={(e) =>
                setSettings({ ...settings, system_prompt: e.target.value })
              }
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
      </Box>
    </VStack>
  );
}
