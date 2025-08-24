import { useEffect, useState, useRef } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Textarea,
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
  NumberInput,
  NumberInputField,
  useDisclosure,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
} from '@chakra-ui/react';
import { DeleteIcon, CheckCircleIcon, WarningIcon, DragHandleIcon } from '@chakra-ui/icons';
import DateSelect from '../components/DateSelect';

interface Item {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  use_initial: boolean;
  use_followup: boolean;
  allow_freetext?: boolean;
}

type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

const DEFAULT_FOLLOWUP_PROMPT = '上記の回答を踏まえ、追加で確認すべき質問を最大{max_questions}個、日本語でJSON配列のみで返してください。';

/** テンプレート管理画面。 */
export default function AdminTemplates() {
  const [items, setItems] = useState<Item[]>([]);
  const [initialPrompt, setInitialPrompt] = useState<string>("");
  const [followupPrompt, setFollowupPrompt] = useState<string>("");
  const [initialFollowupPrompt, setInitialFollowupPrompt] = useState<string>("");
  const [followupFollowupPrompt, setFollowupFollowupPrompt] = useState<string>("");
  const [followupAdvanced, setFollowupAdvanced] = useState<boolean>(false);
  const [newItem, setNewItem] = useState<{
    label: string;
    type: string;
    required: boolean;
    options: string[];
    use_initial: boolean;
    use_followup: boolean;
    allow_freetext: boolean;
  }>({
    label: '',
    type: 'string',
    required: false,
    options: [],
    use_initial: true,
    use_followup: true,
    allow_freetext: false,
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
  const [previewFreeTexts, setPreviewFreeTexts] = useState<Record<string, string>>({});
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [initialEnabled, setInitialEnabled] = useState<boolean>(false);
  const [followupEnabled, setFollowupEnabled] = useState<boolean>(false);
  const [llmAvailable, setLlmAvailable] = useState<boolean>(false);
  const [llmFollowupEnabled, setLlmFollowupEnabled] = useState<boolean>(true);
  const [initialLlmMax, setInitialLlmMax] = useState<number>(5);
  const [followupLlmMax, setFollowupLlmMax] = useState<number>(5);
  const isDirtyRef = useRef<boolean>(false);
  const markDirty = () => {
    isDirtyRef.current = true;
  };
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);

  const [defaultQuestionnaireId, setDefaultQuestionnaireId] = useState('default');
  const [defaultSaveStatus, setDefaultSaveStatus] = useState<SaveStatus>('idle');
  const isInitialDefaultMount = useRef(true);

  useEffect(() => {
    Promise.all([
      fetch('/questionnaires').then((res) => res.json()),
      fetch('/system/default-questionnaire').then((res) => res.json()),
    ]).then(([data, defaultData]) => {
      const ids = Array.from(new Set(data.map((t: any) => t.id))).map((id) => ({ id }));
      setTemplates(ids);
      setTemplateId('default');
      setDefaultQuestionnaireId(defaultData.questionnaire_id || 'default');
    });
  }, []);

  useEffect(() => {
    if (isInitialDefaultMount.current) {
      isInitialDefaultMount.current = false;
      return;
    }
    setDefaultSaveStatus('saving');
    const handler = setTimeout(() => {
      fetch('/system/default-questionnaire', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionnaire_id: defaultQuestionnaireId }),
      })
        .then((res) => {
          if (res.ok) {
            setDefaultSaveStatus('success');
          } else {
            setDefaultSaveStatus('error');
          }
        })
        .catch(() => {
          setDefaultSaveStatus('error');
        });
    }, 1000);
    return () => {
      clearTimeout(handler);
    };
  }, [defaultQuestionnaireId]);

  // LLM の疎通状況を確認し、サマリー生成や追質問のオン可否を制御
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const s = await fetch('/llm/settings').then((r) => r.json());
        if (!s?.enabled || !s?.base_url) {
          if (!cancelled) setLlmAvailable(false);
          return;
        }
        const t = await fetch('/llm/settings/test', { method: 'POST' }).then((r) => r.json());
        if (!cancelled) setLlmAvailable(t?.status === 'ok');
      } catch (e) {
        if (!cancelled) setLlmAvailable(false);
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  // LLM が利用できない場合は追質問設定を強制オフ
  useEffect(() => {
    if (!llmAvailable) setLlmFollowupEnabled(false);
  }, [llmAvailable]);

  useEffect(() => {
    if (templateId && templates.some((t) => t.id === templateId)) {
      loadTemplates(templateId);
    } else {
      setItems([]);
      setInitialPrompt("");
      setFollowupPrompt("");
      setInitialEnabled(false);
      setFollowupEnabled(false);
      setIsLoading(false);
    }
    setIsAddingNewItem(false);
  }, [templateId, templates]);

  // --- 自動保存ロジック（初期ロードやテンプレート切替直後は抑止） ---
  useEffect(() => {
    if (isLoading || isInitialMount.current) {
      if (isInitialMount.current) isInitialMount.current = false;
      return;
    }
    if (!templateId) return;
    // ユーザー編集が入っていない場合は保存を起動しない
    if (!isDirtyRef.current) return;

    setSaveStatus('saving');
    const handler = setTimeout(() => {
      saveTemplate();
    }, 1500); // 1.5秒待ってから保存

    return () => {
      clearTimeout(handler);
    };
  }, [
    items,
    initialPrompt,
    followupPrompt,
    initialFollowupPrompt,
    followupFollowupPrompt,
    followupAdvanced,
    initialEnabled,
    followupEnabled,
    llmFollowupEnabled,
    initialLlmMax,
    followupLlmMax,
    isLoading,
  ]);

  const loadTemplates = (id: string) => {
    setIsLoading(true);
    Promise.all([
      fetch(`/questionnaires/${id}/template?visit_type=initial`).then((r) => r.json()),
      fetch(`/questionnaires/${id}/template?visit_type=followup`).then((r) => r.json()),
      fetch(`/questionnaires/${id}/summary-prompt?visit_type=initial`).then((r) => r.json()),
      fetch(`/questionnaires/${id}/summary-prompt?visit_type=followup`).then((r) => r.json()),
      fetch(`/questionnaires/${id}/followup-prompt?visit_type=initial`).then((r) => r.json()),
      fetch(`/questionnaires/${id}/followup-prompt?visit_type=followup`).then((r) => r.json()),
    ]).then(([init, follow, pInit, pFollow, fInit, fFollow]) => {
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
      const arr = Array.from(map.values());
      setItems(arr);
      setInitialPrompt(pInit?.prompt || "");
      setFollowupPrompt(pFollow?.prompt || "");
      setInitialEnabled(!!pInit?.enabled);
      setFollowupEnabled(!!pFollow?.enabled);
      setInitialFollowupPrompt(fInit?.prompt || DEFAULT_FOLLOWUP_PROMPT);
      setFollowupFollowupPrompt(fFollow?.prompt || DEFAULT_FOLLOWUP_PROMPT);
      setFollowupAdvanced(!!fInit?.enabled || !!fFollow?.enabled);
      setLlmFollowupEnabled(init?.llm_followup_enabled !== false);
      setInitialLlmMax(init?.llm_followup_max_questions ?? 5);
      setFollowupLlmMax(follow?.llm_followup_max_questions ?? 5);
      setPreviewAnswers({});
      setSaveStatus('idle'); // ロード完了時はidleに
      setIsLoading(false);
      // 初期ロード・テンプレ切替直後は dirty をリセット
      isDirtyRef.current = false;
      // 項目が選択された状態にはしない
      setSelectedItemId(null);
    });
  };

  const addItem = () => {
    if (!newItem.label) return;
    const options = ['multi'].includes(newItem.type) ? newItem.options.filter((v) => v) : undefined;
    const newId = crypto.randomUUID();
    setItems([
      ...items,
      {
        id: newId,
        label: newItem.label,
        type: newItem.type,
        required: newItem.required,
        options,
        use_initial: newItem.use_initial,
        use_followup: newItem.use_followup,
        allow_freetext: newItem.allow_freetext,
      },
    ]);
    markDirty();
    setSelectedItemId(newId);
    setNewItem({
      label: '',
      type: 'string',
      required: false,
      options: [],
      use_initial: true,
      use_followup: true,
      allow_freetext: false,
    });
    setIsAddingNewItem(false);
  };

  const updateItem = (index: number, field: keyof Item, value: any) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value } as Item;
    setItems(updated);
    markDirty();
  };

  // 入力方法の変更時に、型に応じて付随プロパティを初期化する
  const changeItemType = (index: number, newType: string) => {
    const target = items[index];
    const next: Item = { ...target, type: newType } as Item;
    if (newType === 'multi' || newType === 'single') {
      // 複数/単一選択に切り替えた場合、自由記述をデフォルトON、選択肢を最低限用意
      next.allow_freetext = true;
      next.options = (target.options && target.options.length > 0) ? target.options : ['', 'その他'];
    } else {
      // それ以外に切り替えたら、選択肢系はリセット
      delete (next as any).options;
      next.allow_freetext = false;
    }
    const updated = [...items];
    updated[index] = next;
    setItems(updated);
    markDirty();
  };

  const removeItem = (index: number) => {
    const removedId = items[index]?.id;
    const updated = items.filter((_, i) => i !== index);
    setItems(updated);
    if (removedId && removedId === selectedItemId) {
      setSelectedItemId(updated.length > 0 ? updated[0].id : null);
    }
    markDirty();
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
        body: JSON.stringify({ id: templateId, visit_type: 'initial', items: initialItems, llm_followup_enabled: llmFollowupEnabled, llm_followup_max_questions: initialLlmMax }),
      });
      await fetch('/questionnaires', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: templateId, visit_type: 'followup', items: followupItems, llm_followup_enabled: llmFollowupEnabled, llm_followup_max_questions: followupLlmMax }),
      });
      // サマリー用プロンプトも保存（有効/無効を含む）
      await fetch(`/questionnaires/${templateId}/summary-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visit_type: 'initial', prompt: initialPrompt || '', enabled: initialEnabled }),
      });
      await fetch(`/questionnaires/${templateId}/summary-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visit_type: 'followup', prompt: followupPrompt || '', enabled: followupEnabled }),
      });
      await fetch(`/questionnaires/${templateId}/followup-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visit_type: 'initial', prompt: initialFollowupPrompt || DEFAULT_FOLLOWUP_PROMPT, enabled: followupAdvanced }),
      });
      await fetch(`/questionnaires/${templateId}/followup-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visit_type: 'followup', prompt: followupFollowupPrompt || DEFAULT_FOLLOWUP_PROMPT, enabled: followupAdvanced }),
      });

      if (!templates.some((t) => t.id === templateId)) {
        setTemplates([...templates, { id: templateId }]);
      }
      setSaveStatus('success');
      // 保存完了時点で最新状態が反映済みのため dirty をリセット
      isDirtyRef.current = false;
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
      } catch (error) {
        console.error('Failed to delete template:', error);
        alert('テンプレートの削除に失敗しました。');
      }
    }
  };

  const duplicateTemplateApi = async (id: string) => {
    const newId = window.prompt(`テンプレート「${id}」の複製先IDを入力してください`, `${id}_copy`);
    if (!newId) return;
    if (templates.some((t) => t.id === newId)) {
      alert('そのIDは既に使用されています。');
      return;
    }
    try {
      await fetch(`/questionnaires/${id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_id: newId }),
      });
      setTemplates([...templates, { id: newId }]);
      setTemplateId(newId);
    } catch (error) {
      console.error('Failed to duplicate template:', error);
      alert('テンプレートの複製に失敗しました。');
    }
  };

  const resetDefaultTemplate = async () => {
    if (window.confirm('デフォルトテンプレートを初期状態に戻します。よろしいですか？')) {
      try {
        await fetch('/questionnaires/default/reset', { method: 'POST' });
        alert('デフォルトテンプレートをリセットしました。');
        if (templateId === 'default') {
          loadTemplates('default');
        } else {
          setTemplateId('default');
        }
      } catch (error) {
        console.error('Failed to reset default template:', error);
        alert('リセットに失敗しました。');
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
    // 新規テンプレート作成時のデフォルト問診項目は「質問文形式」をベースに、
    // 発症時期は単一選択＋自由記述をあらかじめ用意する
    setItems([
      {
        id: crypto.randomUUID(),
        label: '主訴は何ですか？',
        type: 'string',
        required: true,
        use_initial: true,
        use_followup: true,
      },
      {
        id: crypto.randomUUID(),
        label: '発症時期はいつからですか？',
        type: 'single',
        required: false,
        options: ['昨日から', '1週間前から', '1ヶ月前から'],
        allow_freetext: true,
        use_initial: true,
        use_followup: true,
      },
    ]);
    const defaultPrompt = '以下の問診項目と回答をもとに、簡潔で読みやすい日本語のサマリーを作成してください。重要項目（主訴・発症時期）は冒頭にまとめてください。';
    setInitialPrompt(defaultPrompt);
    setFollowupPrompt(defaultPrompt);
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

  const DefaultSaveStatusIndicator = () => {
    switch (defaultSaveStatus) {
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
                作成
              </Button>
            </HStack>
          </Box>
          <Box>
            <HStack justifyContent="space-between" alignItems="center" mb={2}>
              <Heading size="md">
                保存済みテンプレート一覧
              </Heading>
              <DefaultSaveStatusIndicator />
            </HStack>
            <RadioGroup value={defaultQuestionnaireId} onChange={setDefaultQuestionnaireId}>
              <TableContainer overflowX="auto">
                <Table size="sm" minWidth="480px">
                  <Thead>
                    <Tr>
                      <Th>テンプレート名</Th>
                      <Th>操作</Th>
                      <Th>問診に使用</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {templates.map((t) => (
                      <Tr
                        key={t.id}
                        bg={t.id === templateId ? 'blue.100' : 'transparent'}
                        _hover={{ bg: t.id === templateId ? 'blue.100' : 'gray.100' }}
                      >
                        <Td
                          onClick={() => setTemplateId(t.id)}
                          sx={{ cursor: 'pointer' }}
                          fontWeight={t.id === templateId ? 'bold' : 'normal'}
                        >
                          {t.id === 'default' ? '標準テンプレート' : t.id}
                        </Td>
                        <Td onClick={(e) => e.stopPropagation()}>
                          <HStack spacing={1}>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => duplicateTemplateApi(t.id)}
                            >
                              複製
                            </Button>
                            {t.id === 'default' ? (
                              <Button
                                size="xs"
                                colorScheme="orange"
                                variant="outline"
                                onClick={() => resetDefaultTemplate()}
                              >
                                リセット
                              </Button>
                            ) : (
                              <Button
                                size="xs"
                                colorScheme="red"
                                variant="outline"
                                onClick={() => deleteTemplateApi(t.id)}
                              >
                                削除
                              </Button>
                            )}
                          </HStack>
                        </Td>
                        <Td onClick={(e) => e.stopPropagation()}>
                          <Radio value={t.id} />
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </TableContainer>
            </RadioGroup>
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
          {/* LLM 追加質問の有無 */}
          <Box borderWidth="1px" borderRadius="md" p={3} mb={4}>
              <Checkbox
              isChecked={llmFollowupEnabled}
              isDisabled={!llmAvailable}
              onChange={(e) => { setLlmFollowupEnabled(e.target.checked); markDirty(); }}
            >
              回答終了後にLLMによるフォローアップ質問を行う
            </Checkbox>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3} mt={3}>
              <FormControl isDisabled={!llmFollowupEnabled || !llmAvailable}>
                <FormLabel>初診 最大質問数</FormLabel>
                <NumberInput min={0} value={initialLlmMax} onChange={(v) => { setInitialLlmMax(Number(v)); markDirty(); }}>
                  <NumberInputField />
                </NumberInput>
              </FormControl>
              <FormControl isDisabled={!llmFollowupEnabled || !llmAvailable}>
                <FormLabel>再診 最大質問数</FormLabel>
                <NumberInput min={0} value={followupLlmMax} onChange={(v) => { setFollowupLlmMax(Number(v)); markDirty(); }}>
                  <NumberInputField />
                </NumberInput>
              </FormControl>
            </SimpleGrid>
            {!llmAvailable && (
              <Text fontSize="sm" color="gray.500" mt={2}>
                LLMによる追加質問は、LLM設定が有効かつ疎通テストが成功している場合のみオンにできます。
              </Text>
            )}
            <Checkbox mt={3} isChecked={followupAdvanced} isDisabled={!llmFollowupEnabled || !llmAvailable} onChange={(e) => { setFollowupAdvanced(e.target.checked); markDirty(); }}>
              アドバンストモード（プロンプトを編集）
            </Checkbox>
            {followupAdvanced && (
              <Box mt={3}>
                <Text fontSize="sm" color="gray.600" mb={2}>
                  LLMは追加質問をJSON配列のみで返す必要があります。<br />
                  <code>{'{max_questions}'}</code> は最大質問数に置換されます。
                </Text>
                <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3}>
                  <FormControl>
                    <FormLabel>初診用プロンプト</FormLabel>
                    <Textarea rows={4} value={initialFollowupPrompt} onChange={(e) => { setInitialFollowupPrompt(e.target.value); markDirty(); }} />
                    <Button size="sm" mt={1} onClick={() => { setInitialFollowupPrompt(DEFAULT_FOLLOWUP_PROMPT); markDirty(); }}>
                      初期値に戻す
                    </Button>
                  </FormControl>
                  <FormControl>
                    <FormLabel>再診用プロンプト</FormLabel>
                    <Textarea rows={4} value={followupFollowupPrompt} onChange={(e) => { setFollowupFollowupPrompt(e.target.value); markDirty(); }} />
                    <Button size="sm" mt={1} onClick={() => { setFollowupFollowupPrompt(DEFAULT_FOLLOWUP_PROMPT); markDirty(); }}>
                      初期値に戻す
                    </Button>
                  </FormControl>
                </SimpleGrid>
              </Box>
            )}
          </Box>
          {/* サマリー生成設定＋プロンプト編集 */}
          <Box borderWidth="1px" borderRadius="md" p={3} mb={4}>
            <Heading size="sm" mb={2}>サマリー自動作成</Heading>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3} mb={1}>
              <Checkbox isChecked={initialEnabled} isDisabled={!llmAvailable} onChange={(e) => { setInitialEnabled(e.target.checked); markDirty(); }}>
                初診
              </Checkbox>
              <Checkbox isChecked={followupEnabled} isDisabled={!llmAvailable} onChange={(e) => { setFollowupEnabled(e.target.checked); markDirty(); }}>
                再診
              </Checkbox>
            </SimpleGrid>
            {!llmAvailable && (
              <Text fontSize="sm" color="gray.500" mb={3}>
                サマリー作成は、LLM設定が有効かつ疎通テストが成功している場合のみオンにできます。
              </Text>
            )}
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3}>
              {initialEnabled && (
                <FormControl>
                  <FormLabel>初診用プロンプト</FormLabel>
                  <Textarea
                    placeholder="初診サマリーの生成方針を記述（システムプロンプト）"
                    value={initialPrompt}
                    onChange={(e) => { setInitialPrompt(e.target.value); markDirty(); }}
                    rows={6}
                  />
                </FormControl>
              )}
              {followupEnabled && (
                <FormControl>
                  <FormLabel>再診用プロンプト</FormLabel>
                  <Textarea
                    placeholder="再診サマリーの生成方針を記述（システムプロンプト）"
                    value={followupPrompt}
                    onChange={(e) => { setFollowupPrompt(e.target.value); markDirty(); }}
                    rows={6}
                  />
                </FormControl>
              )}
            </SimpleGrid>
          </Box>

          {/* 問診内容（ラベルのみ）の簡易一覧 */}
          <Box borderWidth="1px" borderRadius="md" p={3} mb={4}>
            <Heading size="sm" mb={2}>問診内容一覧(クリックして編集)</Heading>
            {items.length === 0 ? (
              <Text color="gray.500" fontSize="sm">項目がありません。</Text>
            ) : (
              <TableContainer overflowX="auto">
                <Table size="sm" minWidth="100%" variant="striped" colorScheme="gray">
                  <Thead>
                    <Tr>
                      <Th width="2.5rem">並び替え</Th>
                      <Th>問診内容</Th>
                      <Th textAlign="center" width="4.5rem">必須</Th>
                      <Th textAlign="center" width="4.5rem">初診</Th>
                      <Th textAlign="center" width="4.5rem">再診</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {items.map((item, idx) => {
                      const selected = item.id === selectedItemId;
                      return (
                        <>
                          <Tr
                            key={`label-only-${item.id}`}
                            draggable
                            onDragStart={(e) => {
                              setDraggingItemId(item.id);
                              // 軽量のドラッグ画像に
                              try { e.dataTransfer?.setData('text/plain', item.id); } catch {}
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              const el = e.currentTarget as HTMLElement;
                              const rect = el.getBoundingClientRect();
                              const halfway = rect.top + rect.height / 2;
                              const isTop = e.clientY < halfway;
                              el.style.borderTop = isTop ? '3px solid #3182ce' : '';
                              el.style.borderBottom = !isTop ? '3px solid #3182ce' : '';
                            }}
                            onDragLeave={(e) => {
                              const el = e.currentTarget as HTMLElement;
                              el.style.borderTop = '';
                              el.style.borderBottom = '';
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const el = e.currentTarget as HTMLElement;
                              const rect = el.getBoundingClientRect();
                              const halfway = rect.top + rect.height / 2;
                              const isTop = e.clientY < halfway;
                              el.style.borderTop = '';
                              el.style.borderBottom = '';
                              const fromId = draggingItemId || e.dataTransfer?.getData('text/plain');
                              if (!fromId || fromId === item.id) return;
                              const fromIndex = items.findIndex((it) => it.id === fromId);
                              let toIndex = idx + (isTop ? 0 : 1);
                              // 調整: 元の位置を取り除く前提で、後方へ挿入時のインデックスずれを補正
                              if (fromIndex < toIndex) toIndex -= 1;
                              if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
                              const newArr = [...items];
                              const [moved] = newArr.splice(fromIndex, 1);
                              newArr.splice(toIndex, 0, moved);
                              setItems(newArr);
                              markDirty();
                            }}
                            onDragEnd={() => setDraggingItemId(null)}
                            bg={selected ? 'blue.100' : undefined}
                            _hover={{ bg: selected ? 'blue.200' : 'gray.100' }}
                            sx={{ cursor: 'pointer' }}
                            onClick={() => setSelectedItemId(selected ? null : item.id)}
                          >
                            <Td width="1%" pr={1}>
                              <HStack spacing={1} color="gray.500">
                                <DragHandleIcon aria-label="ドラッグして並び替え" cursor="grab" />
                              </HStack>
                            </Td>
                            <Td fontWeight={selected ? 'bold' : 'normal'} whiteSpace="normal" wordBreak="break-word">{item.label}</Td>
                            <Td textAlign="center" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                isChecked={item.required}
                                size="sm"
                                onChange={(e) => updateItem(idx, 'required', e.target.checked)}
                              />
                            </Td>
                            <Td textAlign="center" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                isChecked={item.use_initial}
                                size="sm"
                                onChange={(e) => updateItem(idx, 'use_initial', e.target.checked)}
                              />
                            </Td>
                            <Td textAlign="center" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                isChecked={item.use_followup}
                                size="sm"
                                onChange={(e) => updateItem(idx, 'use_followup', e.target.checked)}
                              />
                            </Td>
                          </Tr>
                          {selected && (
                            <Tr key={`editor-${item.id}`}>
                              <Td colSpan={5} p={0}>
                                <Box p={4} bg="gray.50" borderTopWidth="1px">
                                  <VStack align="stretch" spacing={3}>
                                    <FormControl>
                                      <FormLabel m={0}>問診内容</FormLabel>
                                      <Input value={item.label} onChange={(e) => updateItem(idx, 'label', e.target.value)} />
                                    </FormControl>
                                    <HStack justifyContent="space-between">
                                      <FormControl maxW="360px">
                                        <FormLabel m={0}>入力方法</FormLabel>
                                        <Select value={item.type} onChange={(e) => changeItemType(idx, e.target.value)}>
                                          <option value="string">テキスト</option>
                                          <option value="single">単一選択</option>
                                          <option value="multi">複数選択</option>
                                          <option value="yesno">はい/いいえ</option>
                                          <option value="date">日付</option>
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
                                    {['multi', 'single'].includes(item.type) && (
                                      <Box>
                                        <FormLabel m={0} mb={2}>選択肢</FormLabel>
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
                                          <Checkbox
                                            isChecked={item.allow_freetext}
                                            onChange={(e) => updateItem(idx, 'allow_freetext', e.target.checked)}
                                            alignSelf="flex-end"
                                          >
                                            フリーテキスト入力を許可
                                          </Checkbox>
                                          <Button
                                            size="sm"
                                            py={2}
                                            onClick={() => {
                                              const newOptions = [...(item.options || []), ''];
                                              updateItem(idx, 'options', newOptions);
                                            }}
                                            isDisabled={item.options?.some(opt => !opt.trim())}
                                            alignSelf="flex-end"
                                          >
                                            選択肢を追加
                                          </Button>
                                        </VStack>
                                      </Box>
                                    )}
                                    
                                  </VStack>
                                </Box>
                              </Td>
                            </Tr>
                          )}
                        </>
                      );
                    })}
                  </Tbody>
                </Table>
              </TableContainer>
            )}
            {!isAddingNewItem && (
              <Button onClick={() => setIsAddingNewItem(true)} mt={4} colorScheme="teal">
                問診項目を追加
              </Button>
            )}
          </Box>

          {/* 行内展開のため、ここでの一括編集UIは省略 */}

          {isAddingNewItem && (
            <Box borderWidth="1px" borderRadius="md" p={4} mt={6}>
              <Heading size="md" mb={4}>
                問診項目を追加
              </Heading>
              <VStack spacing={4} align="stretch">
                <FormControl>
                  <FormLabel>新規問診内容</FormLabel>
                  <Input
                    placeholder="例: 主訴は何ですか？"
                    value={newItem.label}
                    onChange={(e) => setNewItem({ ...newItem, label: e.target.value })}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>入力方法</FormLabel>
                  <Select
                    value={newItem.type}
                    onChange={(e) => {
                      const t = e.target.value;
                      if (t === 'multi' || t === 'single') {
                        setNewItem({
                          ...newItem,
                          type: t,
                          allow_freetext: true,
                          options: newItem.options.length > 0 ? newItem.options : ['', 'その他'],
                        });
                      } else {
                        setNewItem({ ...newItem, type: t, allow_freetext: false, options: [] });
                      }
                    }}
                  >
                    <option value="string">テキスト</option>
                    <option value="single">単一選択</option>
                    <option value="multi">複数選択</option>
                    <option value="yesno">はい/いいえ</option>
                    <option value="date">日付</option>
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
                        size="sm"
                        py={2}
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
                {newItem.type === 'multi' && (
                  <Checkbox
                    isChecked={newItem.allow_freetext}
                    onChange={(e) => setNewItem({ ...newItem, allow_freetext: e.target.checked })}
                  >
                    フリーテキスト入力を
                  </Checkbox>
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
                        <>
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
                          {item.allow_freetext && (
                            <Input
                              mt={2}
                              placeholder="自由に記載してください"
                              value={previewFreeTexts[item.id] || ''}
                              onChange={(e) => {
                                const prev = previewFreeTexts[item.id] || '';
                                const selected = (previewAnswers[item.id] || []).filter((v: string) => v !== prev);
                                const val = e.target.value;
                                const updated = val ? [...selected, val] : selected;
                                setPreviewFreeTexts({ ...previewFreeTexts, [item.id]: val });
                                setPreviewAnswers({ ...previewAnswers, [item.id]: updated });
                              }}
                            />
                          )}
                        </>
                      ) : item.type === 'date' ? (
                        <DateSelect
                          value={previewAnswers[item.id] || ''}
                          onChange={(val) => setPreviewAnswers({ ...previewAnswers, [item.id]: val })}
                        />
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
