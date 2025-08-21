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
  use_initial: boolean;
  use_followup: boolean;
}

/** テンプレート管理画面。 */
export default function AdminTemplates() {
  const [items, setItems] = useState<Item[]>([]);
  const [newItem, setNewItem] = useState<{
    label: string;
    type: string;
    required: boolean;
    options: string;
    when: string;
    use_initial: boolean;
    use_followup: boolean;
  }>({
    label: '',
    type: 'string',
    required: false,
    options: '',
    when: '',
    use_initial: true,
    use_followup: true,
  });
  const [templateId, setTemplateId] = useState('default');
  const [templates, setTemplates] = useState<{ id: string }[]>([]);
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, any>>({});
  const [previewVisitType, setPreviewVisitType] = useState<'initial' | 'followup'>('initial');
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
      return;
    }
    loadTemplates(templateId);
    fetch('/questionnaires')
      .then((res) => res.json())
      .then((data) => {
        const ids = Array.from(new Set(data.map((t: any) => t.id))).map((id) => ({ id }));
        setTemplates(ids);
      });
  }, []);

  useEffect(() => {
    loadTemplates(templateId);
  }, [templateId]);

  const loadTemplates = (id: string) => {
    Promise.all([
      fetch(`/questionnaires/${id}/template?visit_type=initial`).then((r) => r.json()),
      fetch(`/questionnaires/${id}/template?visit_type=followup`).then((r) => r.json()),
    ]).then(([init, follow]) => {
      const map = new Map<string, Item>();
      (init.items || []).forEach((it: any) =>
        map.set(it.id, { ...it, use_initial: true, use_followup: false })
      );
      (follow.items || []).forEach((it: any) => {
        const exist = map.get(it.id);
        if (exist) {
          map.set(it.id, { ...exist, ...it, use_initial: exist.use_initial, use_followup: true });
        } else {
          map.set(it.id, { ...it, use_initial: false, use_followup: true });
        }
      });
      setItems(Array.from(map.values()));
      setPreviewAnswers({});
    });
  };

  const addItem = () => {
    if (!newItem.label) return;
    const options = ['multi'].includes(newItem.type)
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
        use_initial: newItem.use_initial,
        use_followup: newItem.use_followup,
      },
    ]);
    setNewItem({
      label: '',
      type: 'string',
      required: false,
      options: '',
      when: '',
      use_initial: true,
      use_followup: true,
    });
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
    const initialItems = items
      .filter((it) => it.use_initial)
      .map(({ use_initial, use_followup, ...rest }) => rest);
    const followupItems = items
      .filter((it) => it.use_followup)
      .map(({ use_initial, use_followup, ...rest }) => rest);
    await fetch('/questionnaires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: templateId, visit_type: 'initial', items: initialItems }),
    });
    await fetch('/questionnaires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: templateId, visit_type: 'followup', items: followupItems }),
    });
    const res = await fetch('/questionnaires');
    const data = await res.json();
    const ids = Array.from(new Set(data.map((t: any) => t.id))).map((id: string) => ({ id }));
    setTemplates(ids);
  };

  const deleteTemplateApi = async (id: string) => {
    await Promise.all([
      fetch(`/questionnaires/${id}?visit_type=initial`, { method: 'DELETE' }),
      fetch(`/questionnaires/${id}?visit_type=followup`, { method: 'DELETE' }),
    ]);
    const res = await fetch('/questionnaires');
    const data = await res.json();
    const ids = Array.from(new Set(data.map((t: any) => t.id))).map((i: string) => ({ id: i }));
    setTemplates(ids);
    if (id === templateId) {
      setTemplateId('default');
    }
  };

  const previewItems = items.filter((item) => {
    if (previewVisitType === 'initial' && !item.use_initial) return false;
    if (previewVisitType === 'followup' && !item.use_followup) return false;
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
            <Th>初診</Th>
            <Th>再診</Th>
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
                  <option value="multi">複数選択</option>
                  <option value="yesno">YES/NO</option>
                </Select>
              </Td>
              <Td>
                {['multi'].includes(item.type) ? (
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
                <Checkbox
                  isChecked={item.use_initial}
                  onChange={(e) => updateItem(idx, 'use_initial', e.target.checked)}
                />
              </Td>
              <Td>
                <Checkbox
                  isChecked={item.use_followup}
                  onChange={(e) => updateItem(idx, 'use_followup', e.target.checked)}
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
              <option value="multi">複数選択</option>
              <option value="yesno">YES/NO</option>
            </Select>
          </FormControl>
          {['multi'].includes(newItem.type) && (
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
          <Checkbox
            isChecked={newItem.use_initial}
            onChange={(e) => setNewItem({ ...newItem, use_initial: e.target.checked })}
          >
            初診に含める
          </Checkbox>
          <Checkbox
            isChecked={newItem.use_followup}
            onChange={(e) => setNewItem({ ...newItem, use_followup: e.target.checked })}
          >
            再診に含める
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
              <Th>操作</Th>
            </Tr>
          </Thead>
          <Tbody>
            {templates.map((t, i) => (
              <Tr key={i}>
                <Td>{t.id}</Td>
                <Td>
                  <Button
                    size="xs"
                    mr={2}
                    colorScheme="primary"
                    variant="outline"
                    onClick={() => setTemplateId(t.id)}
                  >
                    編集
                  </Button>
                  <Button
                    size="xs"
                    colorScheme="red"
                    variant="outline"
                    onClick={() => deleteTemplateApi(t.id)}
                  >
                    削除
                  </Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
      <Box borderWidth="1px" borderRadius="md" p={4} w="100%">
        <Box fontWeight="bold" mb={2}>プレビュー</Box>
        <FormControl mb={4}>
          <FormLabel>受診種別</FormLabel>
          <Select
            value={previewVisitType}
            onChange={(e) => {
              setPreviewVisitType(e.target.value as any);
              setPreviewAnswers({});
            }}
          >
            <option value="initial">初診</option>
            <option value="followup">再診</option>
          </Select>
        </FormControl>
        <VStack spacing={3} align="stretch">
          {previewItems.map((item) => (
            <FormControl key={item.id} isRequired={item.required}>
              <FormLabel>{item.label}</FormLabel>
              {item.type === 'yesno' ? (
                <RadioGroup onChange={(val) => setPreviewAnswers({ ...previewAnswers, [item.id]: val })}>
                  <VStack align="start">
                    <Radio value="yes" size="lg">はい</Radio>
                    <Radio value="no" size="lg">いいえ</Radio>
                  </VStack>
                </RadioGroup>
              ) : item.type === 'single' && item.options ? (
                <RadioGroup onChange={(val) => setPreviewAnswers({ ...previewAnswers, [item.id]: val })}>
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
