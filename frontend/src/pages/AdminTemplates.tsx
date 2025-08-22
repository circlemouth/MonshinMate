import { useEffect, useState, useRef } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  Table,
  TableContainer,
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
  HStack,
  IconButton,
  Heading,
  Text,
  Spinner,
  Card,
  CardHeader,
  CardBody,
  SimpleGrid,
  useDisclosure,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
} from '@chakra-ui/react';
import { DeleteIcon, CheckCircleIcon, WarningIcon } from '@chakra-ui/icons';

interface Item {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  use_initial: boolean;
  use_followup: boolean;
}

type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

/** テンプレート管理画面。 */
export default function AdminTemplates() {
  const [items, setItems] = useState<Item[]>([]);
  const [newItem, setNewItem] = useState<{
    label: string;
    type: string;
    required: boolean;
    options: string[];
    use_initial: boolean;
    use_followup: boolean;
  }>({
    label: '',
    type: 'string',
    required: false,
    options: [],
    use_initial: true,
    use_followup: true,
  });
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ id: string }[]>([]);
  const [newTemplateId, setNewTemplateId] = useState('');
  const [isAddingNewItem, setIsAddingNewItem] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, any>>({});
  const [previewVisitType, setPreviewVisitType] = useState<'initial' | 'followup'>('initial');
  const previewModal = useDisclosure();
  const isInitialMount = useRef(true);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/questionnaires')
      .then((res) => res.json())
      .then((data) => {
        const ids = Array.from(new Set(data.map((t: any) => t.id))).map((id) => ({ id }));
        setTemplates(ids);
        setTemplateId('default');
      });
  }, []);

  useEffect(() => {
    if (templateId && templates.some((t) => t.id === templateId)) {
      loadTemplates(templateId);
    } else {
      setItems([]);
      setIsLoading(false);
    }
    setIsAddingNewItem(false);
  }, [templateId, templates]);

  // --- 自動保存ロジック ---
  useEffect(() => {
    if (isLoading || isInitialMount.current) {
      if (isInitialMount.current) isInitialMount.current = false;
      return;
    }
    if (!templateId) return;

    setSaveStatus('saving');
    const handler = setTimeout(() => {
      saveTemplate();
    }, 1500); // 1.5秒待ってから保存

    return () => {
      clearTimeout(handler);
    };
  }, [items, isLoading]);

  const loadTemplates = (id: string) => {
    setIsLoading(true);
    Promise.all([
      fetch(`/questionnaires/${id}/template?visit_type=initial`).then((r) => r.json()),
      fetch(`/questionnaires/${id}/template?visit_type=followup`).then((r) => r.json()),
    ]).then(([init, follow]) => {
      const map = new Map<string, Item>();
      (init.items || []).forEach((it: any) => map.set(it.id, { ...it, use_initial: true, use_followup: false }));
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
      setSaveStatus('idle'); // ロード完了時はidleに
      setIsLoading(false);
    });
  };

  const addItem = () => {
    if (!newItem.label) return;
    const options = ['multi'].includes(newItem.type) ? newItem.options.filter((v) => v) : undefined;
    setItems([
      ...items,
      {
        id: crypto.randomUUID(),
        label: newItem.label,
        type: newItem.type,
        required: newItem.required,
        options,
        use_initial: newItem.use_initial,
        use_followup: newItem.use_followup,
      },
    ]);
    setNewItem({
      label: '',
      type: 'string',
      required: false,
      options: [],
      use_initial: true,
      use_followup: true,
    });
    setIsAddingNewItem(false);
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
    if (!templateId) return;
    setSaveStatus('saving');
    try {
      const initialItems = items.filter((it) => it.use_initial).map(({ use_initial, use_followup, ...rest }) => rest);
      const followupItems = items.filter((it) => it.use_followup).map(({ use_initial, use_followup, ...rest }) => rest);
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

      if (!templates.some((t) => t.id === templateId)) {
        setTemplates([...templates, { id: templateId }]);
      }
      setSaveStatus('success');
    } catch (error) {
      console.error('Failed to save template:', error);
      setSaveStatus('error');
    }
  };

  const deleteTemplateApi = async (id: string) => {
    if (window.confirm(`テンプレート「${id}」を削除しますか？`)) {
      try {
        await Promise.all([
          fetch(`/questionnaires/${id}?visit_type=initial`, { method: 'DELETE' }),
          fetch(`/questionnaires/${id}?visit_type=followup`, { method: 'DELETE' }),
        ]);

        const newTemplates = templates.filter((t) => t.id !== id);
        setTemplates(newTemplates);

        if (id === templateId) {
          setTemplateId('default');
        }
        alert('テンプレートを削除しました。');
      } catch (error) {
        console.error('Failed to delete template:', error);
        alert('テンプレートの削除に失敗しました。');
      }
    }
  };

  const handleCreateNewTemplate = () => {
    const newId = newTemplateId.trim();
    if (!newId) {
      alert('IDを入力してください。');
      return;
    }
    if (templates.some((t) => t.id === newId)) {
      alert('そのIDは既に使用されています。');
      return;
    }
    setTemplates([...templates, { id: newId }]);
    setTemplateId(newId);
    setItems([]);
    setNewTemplateId('');
  };

  const SaveStatusIndicator = () => {
    switch (saveStatus) {
      case 'saving':
        return (
          <HStack>
            <Spinner size="sm" />
            <Text>保存中...</Text>
          </HStack>
        );
      case 'success':
        return (
          <HStack>
            <CheckCircleIcon color="green.500" />
            <Text>保存済み</Text>
          </HStack>
        );
      case 'error':
        return (
          <HStack>
            <WarningIcon color="red.500" />
            <Text>保存エラー</Text>
          </HStack>
        );
      default:
        return null;
    }
  };

  const previewItems = items.filter((item) => {
    if (previewVisitType === 'initial' && !item.use_initial) return false;
    if (previewVisitType === 'followup' && !item.use_followup) return false;
    return true;
  });

  return (
    <VStack spacing={8} align="stretch">
      <Box borderWidth="1px" borderRadius="md" p={4}>
        <Heading size="lg" mb={4}>
          テンプレート管理
        </Heading>
        <VStack align="stretch" spacing={6}>
          <Box>
            <Heading size="md" mb={2}>
              新規テンプレート作成
            </Heading>
            <HStack>
              <Input
                placeholder="新しいテンプレート名"
                value={newTemplateId}
                onChange={(e) => setNewTemplateId(e.target.value)}
              />
              <Button onClick={handleCreateNewTemplate} colorScheme="green">
                作成して編集
              </Button>
            </HStack>
          </Box>
          <Box>
            <Heading size="md" mb={2}>
              保存済みテンプレート一覧
            </Heading>
            <TableContainer overflowX="auto">
              <Table size="sm" minWidth="480px">
                <Thead>
                  <Tr>
                    <Th>テンプレート名</Th>
                    <Th>操作</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {templates.map((t) => (
                    <Tr
                      key={t.id}
                      bg={t.id === templateId ? 'blue.100' : 'transparent'}
                      onClick={() => setTemplateId(t.id)}
                      sx={{ cursor: 'pointer' }}
                      _hover={{ bg: t.id === templateId ? 'blue.100' : 'gray.100' }}
                    >
                      <Td fontWeight={t.id === templateId ? 'bold' : 'normal'}>
                        {t.id === 'default' ? 'デフォルト' : t.id}
                      </Td>
                      <Td onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="xs"
                          colorScheme="red"
                          variant="outline"
                          onClick={() => deleteTemplateApi(t.id)}
                          isDisabled={t.id === 'default'}
                        >
                          削除
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </TableContainer>
          </Box>
        </VStack>
      </Box>

      {templateId && (
        <Box borderWidth="1px" borderRadius="md" p={4}>
          <HStack justifyContent="space-between" mb={4}>
            <VStack align="start" spacing={0}>
              <Heading size="lg">問診内容一覧</Heading>
              <Text fontSize="sm" color="gray.500">
                テンプレート: {templateId === 'default' ? 'デフォルト' : templateId}
              </Text>
            </VStack>
            <HStack>
              <Button onClick={previewModal.onOpen} variant="outline">
                プレビュー
              </Button>
              <SaveStatusIndicator />
            </HStack>
          </HStack>
          {/* カード表示（常時） */}
          <VStack align="stretch" spacing={4}>
            {items.map((item, idx) => (
              <Card key={item.id} variant="outline">
                <CardHeader pb={2}>
                  <VStack align="stretch" spacing={2}>
                    <FormControl>
                      <FormLabel m={0}>問診内容</FormLabel>
                      <Input value={item.label} onChange={(e) => updateItem(idx, 'label', e.target.value)} />
                    </FormControl>
                    <HStack justifyContent="space-between">
                      <FormControl maxW="360px">
                        <FormLabel m={0}>入力方法</FormLabel>
                        <Select value={item.type} onChange={(e) => updateItem(idx, 'type', e.target.value)}>
                          <option value="string">テキスト</option>
                          <option value="multi">複数選択</option>
                          <option value="yesno">はい/いいえ</option>
                        </Select>
                      </FormControl>
                      <IconButton
                        aria-label="項目を削除"
                        icon={<DeleteIcon />}
                        size="sm"
                        colorScheme="red"
                        variant="outline"
                        onClick={() => removeItem(idx)}
                      />
                    </HStack>
                  </VStack>
                </CardHeader>
                <CardBody pt={2}>
                  {['multi'].includes(item.type) && (
                    <Box mb={3}>
                      <FormLabel m={0} mb={2}>
                        選択肢
                      </FormLabel>
                      <VStack align="stretch">
                        {item.options?.map((opt, optIdx) => (
                          <HStack key={optIdx}>
                            <Input
                              value={opt}
                              onChange={(e) => {
                                const newOptions = [...(item.options || [])];
                                newOptions[optIdx] = e.target.value;
                                updateItem(idx, 'options', newOptions);
                              }}
                            />
                            <IconButton
                              aria-label="選択肢を削除"
                              icon={<DeleteIcon />}
                              size="sm"
                              onClick={() => {
                                const newOptions = [...(item.options || [])];
                                newOptions.splice(optIdx, 1);
                                updateItem(idx, 'options', newOptions);
                              }}
                            />
                          </HStack>
                        ))}
                        <Button
                          size="xs"
                          onClick={() => {
                            const newOptions = [...(item.options || []), ''];
                            updateItem(idx, 'options', newOptions);
                          }}
                        >
                          選択肢を追加
                        </Button>
                      </VStack>
                    </Box>
                  )}
                  <SimpleGrid columns={{ base: 1, sm: 3 }} spacing={3}>
                    <Checkbox isChecked={item.required} onChange={(e) => updateItem(idx, 'required', e.target.checked)}>
                      必須
                    </Checkbox>
                    <Checkbox isChecked={item.use_initial} onChange={(e) => updateItem(idx, 'use_initial', e.target.checked)}>
                      初診
                    </Checkbox>
                    <Checkbox isChecked={item.use_followup} onChange={(e) => updateItem(idx, 'use_followup', e.target.checked)}>
                      再診
                    </Checkbox>
                  </SimpleGrid>
                </CardBody>
              </Card>
            ))}
          </VStack>

          {!isAddingNewItem && (
            <Button onClick={() => setIsAddingNewItem(true)} mt={6} colorScheme="teal">
              新規項目を追加
            </Button>
          )}

          {isAddingNewItem && (
            <Box borderWidth="1px" borderRadius="md" p={4} mt={6}>
              <Heading size="md" mb={4}>
                新規項目を追加
              </Heading>
              <VStack spacing={4} align="stretch">
                <FormControl>
                  <FormLabel>新規問診内容</FormLabel>
                  <Input value={newItem.label} onChange={(e) => setNewItem({ ...newItem, label: e.target.value })} />
                </FormControl>
                <FormControl>
                  <FormLabel>入力方法</FormLabel>
                  <Select value={newItem.type} onChange={(e) => setNewItem({ ...newItem, type: e.target.value })}>
                    <option value="string">テキスト</option>
                    <option value="multi">複数選択</option>
                    <option value="yesno">はい/いいえ</option>
                  </Select>
                </FormControl>
                {['multi'].includes(newItem.type) && (
                  <FormControl>
                    <FormLabel>選択肢</FormLabel>
                    <VStack align="stretch">
                      {newItem.options.map((opt, optIdx) => (
                        <HStack key={optIdx}>
                          <Input
                            value={opt}
                            onChange={(e) => {
                              const newOptions = [...newItem.options];
                              newOptions[optIdx] = e.target.value;
                              setNewItem({ ...newItem, options: newOptions });
                            }}
                          />
                          <IconButton
                            aria-label="選択肢を削除"
                            icon={<DeleteIcon />}
                            size="sm"
                            onClick={() => {
                              const newOptions = [...newItem.options];
                              newOptions.splice(optIdx, 1);
                              setNewItem({ ...newItem, options: newOptions });
                            }}
                          />
                        </HStack>
                      ))}
                      <Button
                        size="xs"
                        onClick={() => {
                          const newOptions = [...newItem.options, ''];
                          setNewItem({ ...newItem, options: newOptions });
                        }}
                      >
                        選択肢を追加
                      </Button>
                    </VStack>
                  </FormControl>
                )}
                <HStack>
                  <Checkbox isChecked={newItem.required} onChange={(e) => setNewItem({ ...newItem, required: e.target.checked })}>
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
                </HStack>
                <HStack justifyContent="flex-end">
                  <Button onClick={() => setIsAddingNewItem(false)} variant="ghost">
                    キャンセル
                  </Button>
                  <Button onClick={addItem} colorScheme="primary">
                    確定
                  </Button>
                </HStack>
              </VStack>
            </Box>
          )}
        </Box>
      )}

      {/* プレビューモーダル */}
      <Modal isOpen={previewModal.isOpen} onClose={previewModal.onClose} size="xl" scrollBehavior="inside">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>プレビュー</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {items.length > 0 ? (
              <>
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
                        <RadioGroup
                          onChange={(val) => setPreviewAnswers({ ...previewAnswers, [item.id]: val })}
                          value={previewAnswers[item.id] || ''}
                        >
                          <VStack align="start">
                            <Radio value="yes" size="lg">
                              はい
                            </Radio>
                            <Radio value="no" size="lg">
                              いいえ
                            </Radio>
                          </VStack>
                        </RadioGroup>
                      ) : item.type === 'multi' && item.options ? (
                        <CheckboxGroup
                          onChange={(vals) => setPreviewAnswers({ ...previewAnswers, [item.id]: vals })}
                          value={previewAnswers[item.id] || []}
                        >
                          <VStack align="start">
                            {item.options.map((opt) => (
                              <Checkbox key={opt} value={opt} size="lg">
                                {opt}
                              </Checkbox>
                            ))}
                          </VStack>
                        </CheckboxGroup>
                      ) : (
                        <Input
                          onChange={(e) => setPreviewAnswers({ ...previewAnswers, [item.id]: e.target.value })}
                          value={previewAnswers[item.id] || ''}
                        />
                      )}
                    </FormControl>
                  ))}
                </VStack>
              </>
            ) : (
              <Box>プレビューする項目がありません。</Box>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </VStack>
  );
}

