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
  Box,
  Checkbox,
  RadioGroup,
  Radio,
  CheckboxGroup,
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';

interface Item {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  when?: { item_id: string; equals: string };
}

/** テンプレート管理画面。 */
export default function AdminTemplates() {
  const [items, setItems] = useState<Item[]>([]);
  const [newItem, setNewItem] = useState<{ label: string; type: string; required: boolean; options: string; when: string }>({
    label: '',
    type: 'string',
    required: false,
    options: '',
    when: '',
  });
  const [templateId, setTemplateId] = useState('default');
  const [visitType, setVisitType] = useState<'initial' | 'followup'>('initial');
  const [templates, setTemplates] = useState<{ id: string; visit_type: string }[]>([]);
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, any>>({});
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
      return;
    }
    fetch(`/questionnaires/${templateId}/template?visit_type=${visitType}`)
      .then((res) => res.json())
      .then((data) => {
        setItems(data.items);
        setPreviewAnswers({});
      });
    fetch('/questionnaires')
      .then((res) => res.json())
      .then((data) => setTemplates(data));
  }, []);

  useEffect(() => {
    fetch(`/questionnaires/${templateId}/template?visit_type=${visitType}`)
      .then((res) => res.json())
      .then((data) => {
        setItems(data.items);
        setPreviewAnswers({});
      });
  }, [templateId, visitType]);

  const addItem = () => {
    if (!newItem.label) return;
    const options = ['single', 'multi'].includes(newItem.type)
      ? newItem.options
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v)
      : undefined;
    const when = newItem.when
      ? (() => {
          const [id, val] = newItem.when.split('=').map((v) => v.trim());
          return id && val ? { item_id: id, equals: val } : undefined;
        })()
      : undefined;
    setItems([
      ...items,
      {
        id: `item${items.length + 1}`,
        label: newItem.label,
        type: newItem.type,
        required: newItem.required,
        options,
        when,
      },
    ]);
    setNewItem({ label: '', type: 'string', required: false, options: '', when: '' });
  };

  const updateItem = (index: number, field: keyof Item, value: any) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value } as Item;
    setItems(updated);
  };

  const removeItem = (index: number) => {
    const updated = items.filter((_, i) => i !== index);
    setItems(updated);
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
      setTemplateId('default');
      setVisitType('initial');
    }
  };

  const previewItems = items.filter((item) => {
    if (!item.when) return true;
    return previewAnswers[item.when.item_id] === item.when.equals;
  });

  return (
    <VStack spacing={4} align="stretch">
      <Table size="sm">
        <Thead>
          <Tr>
            <Th>ID</Th>
            <Th>ラベル</Th>
            <Th>型</Th>
            <Th>選択肢</Th>
            <Th>表示条件</Th>
            <Th>必須</Th>
            <Th></Th>
          </Tr>
        </Thead>
        <Tbody>
          {items.map((item, idx) => (
            <Tr key={item.id}>
              <Td>{item.id}</Td>
              <Td>
                <Input
                  value={item.label}
                  onChange={(e) => updateItem(idx, 'label', e.target.value)}
                />
              </Td>
              <Td>
                <Select
                  value={item.type}
                  onChange={(e) => updateItem(idx, 'type', e.target.value)}
                >
                  <option value="string">テキスト</option>
                  <option value="number">数値</option>
                  <option value="date">日付</option>
                  <option value="single">単一選択</option>
                  <option value="multi">複数選択</option>
                </Select>
              </Td>
              <Td>
                {['single', 'multi'].includes(item.type) ? (
                  <Input
                    value={item.options?.join(',') || ''}
                    onChange={(e) =>
                      updateItem(
                        idx,
                        'options',
                        e.target.value
                          .split(',')
                          .map((v) => v.trim())
                          .filter((v) => v)
                      )
                    }
                  />
                ) : null}
              </Td>
              <Td>
                <Input
                  placeholder="id=値"
                  value={item.when ? `${item.when.item_id}=${item.when.equals}` : ''}
                  onChange={(e) => {
                    const [id, val] = e.target.value.split('=');
                    updateItem(
                      idx,
                      'when',
                      id && val ? { item_id: id.trim(), equals: val.trim() } : undefined,
                    );
                  }}
                />
              </Td>
              <Td>
                <Checkbox
                  isChecked={item.required}
                  onChange={(e) => updateItem(idx, 'required', e.target.checked)}
                />
              </Td>
              <Td>
                <Button size="xs" onClick={() => removeItem(idx)} colorScheme="red" variant="outline">
                  削除
                </Button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
      <FormControl>
        <FormLabel>テンプレートID</FormLabel>
        <Input value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
      </FormControl>
      <FormControl>
        <FormLabel>受診種別</FormLabel>
        <Select value={visitType} onChange={(e) => setVisitType(e.target.value as any)}>
          <option value="initial">初診</option>
          <option value="followup">再診</option>
        </Select>
      </FormControl>
      <Box borderWidth="1px" borderRadius="md" p={4}>
        <VStack spacing={2} align="stretch">
          <FormControl>
            <FormLabel>新規項目ラベル</FormLabel>
            <Input
              value={newItem.label}
              onChange={(e) => setNewItem({ ...newItem, label: e.target.value })}
            />
          </FormControl>
          <FormControl>
            <FormLabel>型</FormLabel>
            <Select
              value={newItem.type}
              onChange={(e) => setNewItem({ ...newItem, type: e.target.value })}
            >
              <option value="string">テキスト</option>
              <option value="number">数値</option>
              <option value="date">日付</option>
              <option value="single">単一選択</option>
              <option value="multi">複数選択</option>
            </Select>
          </FormControl>
          {['single', 'multi'].includes(newItem.type) && (
            <FormControl>
              <FormLabel>選択肢（カンマ区切り）</FormLabel>
              <Input
                value={newItem.options}
                onChange={(e) => setNewItem({ ...newItem, options: e.target.value })}
              />
            </FormControl>
          )}
          <FormControl>
            <FormLabel>表示条件（id=値）</FormLabel>
            <Input
              value={newItem.when}
              onChange={(e) => setNewItem({ ...newItem, when: e.target.value })}
            />
          </FormControl>
          <Checkbox
            isChecked={newItem.required}
            onChange={(e) => setNewItem({ ...newItem, required: e.target.checked })}
          >
            必須
          </Checkbox>
          <Button onClick={addItem} colorScheme="primary">
            追加（ローカル）
          </Button>
        </VStack>
      </Box>
      <Button onClick={saveTemplate} colorScheme="primary">
        テンプレートを保存
      </Button>
      <Box>
        既存テンプレ一覧:
        <Table size="sm" mt={2}>
          <Thead>
            <Tr>
              <Th>ID</Th>
              <Th>受診種別</Th>
              <Th>操作</Th>
            </Tr>
          </Thead>
          <Tbody>
            {templates.map((t, i) => (
              <Tr key={i}>
                <Td>{t.id}</Td>
                <Td>{t.visit_type}</Td>
                <Td>
                  <Button size="xs" mr={2} colorScheme="primary" variant="outline" onClick={() => { setTemplateId(t.id); setVisitType(t.visit_type as any); }}>編集</Button>
                  <Button size="xs" colorScheme="red" variant="outline" onClick={() => deleteTemplateApi(t.id, t.visit_type)}>削除</Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
      <Box borderWidth="1px" borderRadius="md" p={4} w="100%">
        <Box fontWeight="bold" mb={2}>プレビュー</Box>
        <VStack spacing={3} align="stretch">
          {previewItems.map((item) => (
            <FormControl key={item.id} isRequired={item.required}>
              <FormLabel>{item.label}</FormLabel>
              {item.type === 'number' ? (
                <Input
                  type="number"
                  onChange={(e) => setPreviewAnswers({ ...previewAnswers, [item.id]: e.target.value })}
                />
              ) : item.type === 'date' ? (
                <Input
                  type="date"
                  onChange={(e) => setPreviewAnswers({ ...previewAnswers, [item.id]: e.target.value })}
                />
              ) : item.type === 'single' && item.options ? (
                <RadioGroup
                  onChange={(val) => setPreviewAnswers({ ...previewAnswers, [item.id]: val })}
                >
                  <VStack align="start">
                {item.options.map((opt) => (
                  <Radio key={opt} value={opt} size="lg">{opt}</Radio>
                ))}
                  </VStack>
                </RadioGroup>
              ) : item.type === 'multi' && item.options ? (
                <CheckboxGroup
                  onChange={(vals) => setPreviewAnswers({ ...previewAnswers, [item.id]: vals })}
                >
                  <VStack align="start">
                {item.options.map((opt) => (
                  <Checkbox key={opt} value={opt} size="lg">{opt}</Checkbox>
                ))}
                  </VStack>
                </CheckboxGroup>
              ) : (
                <Input onChange={(e) => setPreviewAnswers({ ...previewAnswers, [item.id]: e.target.value })} />
              )}
            </FormControl>
          ))}
        </VStack>
      </Box>
    </VStack>
  );
}
