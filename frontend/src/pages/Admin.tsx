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
  const [templateId, setTemplateId] = useState('default');
  const [visitType, setVisitType] = useState<'initial' | 'followup'>('initial');
  const [settings, setSettings] = useState({
    provider: 'ollama',
    model: '',
    temperature: 0.2,
    system_prompt: '',
  });
  const [templates, setTemplates] = useState<{id: string, visit_type: string}[]>([]);

  useEffect(() => {
    fetch(`/questionnaires/${templateId}/template?visit_type=${visitType}`)
      .then((res) => res.json())
      .then((data) => setItems(data.items));
    fetch('/llm/settings')
      .then((res) => res.json())
      .then((data) => setSettings(data));
    fetch('/questionnaires')
      .then((res) => res.json())
      .then((data) => setTemplates(data));
  }, []);

  // visitType または templateId が変わったら対象テンプレを再読込
  useEffect(() => {
    fetch(`/questionnaires/${templateId}/template?visit_type=${visitType}`)
      .then((res) => res.json())
      .then((data) => setItems(data.items));
  }, [templateId, visitType]);

  const addItem = () => {
    setItems([
      ...items,
      { id: `item${items.length + 1}`, label: newLabel, type: 'string', required: false },
    ]);
    setNewLabel('');
  };

  const saveTemplate = async () => {
    await fetch('/questionnaires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: templateId, visit_type: visitType, items }),
    });
    const res = await fetch('/questionnaires');
    setTemplates(await res.json());
  };

  const deleteTemplateApi = async (id: string, vt: string) => {
    await fetch(`/questionnaires/${id}?visit_type=${vt}`, { method: 'DELETE' });
    const res = await fetch('/questionnaires');
    setTemplates(await res.json());
    if (id === templateId && vt === visitType) {
      // 現在編集中を削除した場合は default/initial を再読込
      setTemplateId('default');
      setVisitType('initial');
    }
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
        <FormLabel>テンプレートID</FormLabel>
        <Input value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
      </FormControl>
      <FormControl>
        <FormLabel>visit_type</FormLabel>
        <Select value={visitType} onChange={(e) => setVisitType(e.target.value as any)}>
          <option value="initial">initial</option>
          <option value="followup">followup</option>
        </Select>
      </FormControl>
      <FormControl>
        <FormLabel>新規項目ラベル</FormLabel>
        <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
      </FormControl>
      <Button onClick={addItem} colorScheme="blue">
        追加（ローカル）
      </Button>
      <Button onClick={saveTemplate} colorScheme="teal">
        テンプレートを保存
      </Button>
      <Box>
        既存テンプレ一覧:
        <Table size="sm" mt={2}>
          <Thead>
            <Tr><Th>ID</Th><Th>visit_type</Th><Th>操作</Th></Tr>
          </Thead>
          <Tbody>
            {templates.map((t, i) => (
              <Tr key={i}>
                <Td>{t.id}</Td>
                <Td>{t.visit_type}</Td>
                <Td>
                  <Button size="xs" mr={2} onClick={() => { setTemplateId(t.id); setVisitType(t.visit_type as any); }}>編集</Button>
                  <Button size="xs" colorScheme="red" variant="outline" onClick={() => deleteTemplateApi(t.id, t.visit_type)}>削除</Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
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
