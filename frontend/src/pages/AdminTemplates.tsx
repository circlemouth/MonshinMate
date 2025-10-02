import { useEffect, useState, useRef, useMemo, Fragment } from 'react';
import type { DragEvent } from 'react';
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
  Alert,
  AlertIcon,
  Flex,
  HStack,
  IconButton,
  Heading,
  Text,
  Spinner,
  SimpleGrid,
  NumberInput,
  NumberInputField,
  Slider,
  SliderTrack,
  SliderFilledTrack,
  SliderThumb,
  RangeSlider,
  RangeSliderTrack,
  RangeSliderFilledTrack,
  RangeSliderThumb,
  Tooltip,
  Badge,
  useDisclosure,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  ModalFooter,
  FormHelperText,
  Image,
  Icon,
  // removed: postal lookup UI wrappers
} from '@chakra-ui/react';
import { DeleteIcon, CheckCircleIcon, WarningIcon, DragHandleIcon, QuestionIcon } from '@chakra-ui/icons';
import { MdImage, MdWc, MdCalendarToday } from 'react-icons/md';
import { BiGitBranch } from 'react-icons/bi';
import DateSelect from '../components/DateSelect';
import AccentOutlineBox from '../components/AccentOutlineBox';
import { LlmStatus, checkLlmStatus } from '../utils/llmStatus';
import { useNotify } from '../contexts/NotificationContext';
import { useDialog } from '../contexts/DialogContext';
// removed: postal-code address lookup logic

interface Item {
  id: string;
  label: string;
  type: string;
    required: boolean;
    options?: string[];
    use_initial: boolean;
    use_followup: boolean;
    allow_freetext?: boolean;
    description?: string;
    gender_enabled?: boolean;
    gender?: string;
    age_enabled?: boolean;
    min_age?: number;
    max_age?: number;
    min?: number;
    max?: number;
    image?: string;
  followups?: Record<string, Item[]>;
}

type FollowupPathSegment = { parentId: string; optionKey: string };

type OptionDragContext = (
  | { kind: 'item'; itemIndex: number; optionIndex: number }
  | { kind: 'new'; optionIndex: number }
  | { kind: 'followup'; followupIndex: number; optionIndex: number }
);

type NewItemState = {
  label: string;
  type: string;
  required: boolean;
  options: string[];
  use_initial: boolean;
  use_followup: boolean;
  allow_freetext: boolean;
  description: string;
  gender_enabled: boolean;
  gender: string;
  age_enabled: boolean;
  min_age: string;
  max_age: string;
  image: string;
  min: string;
  max: string;
};

const createEmptyNewItem = (): NewItemState => ({
  label: '',
  type: 'string',
  required: false,
  options: [],
  use_initial: true,
  use_followup: true,
  allow_freetext: false,
  description: '',
  gender_enabled: false,
  gender: 'male',
  age_enabled: false,
  min_age: '',
  max_age: '',
  image: '',
  min: '0',
  max: '10',
});

const reorderList = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  if (from < 0 || from >= list.length) {
    return next;
  }
  const [moved] = next.splice(from, 1);
  let targetIndex = to;
  if (to >= list.length) {
    targetIndex = next.length;
  } else if (from < to) {
    targetIndex = Math.max(0, to - 1);
  }
  if (targetIndex < 0) targetIndex = 0;
  if (targetIndex > next.length) targetIndex = next.length;
  next.splice(targetIndex, 0, moved);
  return next;
};

type HiddenPersonalInfoEntry = { path: FollowupPathSegment[]; index: number; item: Item };

type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

const DEFAULT_FOLLOWUP_PROMPT = '上記の患者回答を踏まえ、診療に必要な追加確認事項を最大{max_questions}個生成してください。各質問は丁寧な日本語の文章で記述し、文字列のみを要素とするJSON配列として返してください。';

/** テンプレート管理画面。 */
export default function AdminTemplates() {
  const [items, setItems] = useState<Item[]>([]);
  const [initialPrompt, setInitialPrompt] = useState<string>("");
  const [followupPrompt, setFollowupPrompt] = useState<string>("");
  const [initialFollowupPrompt, setInitialFollowupPrompt] = useState<string>("");
  const [followupFollowupPrompt, setFollowupFollowupPrompt] = useState<string>("");
  const [followupAdvanced, setFollowupAdvanced] = useState<boolean>(false);
  const [itemViewFilter, setItemViewFilter] = useState<'all' | 'required' | 'initial' | 'followup'>('all');
  const [newItem, setNewItem] = useState<NewItemState>(() => createEmptyNewItem());

  const hiddenPersonalInfoRef = useRef<HiddenPersonalInfoEntry[]>([]);

  const cloneItems = (source: Item[]): Item[] =>
    source.map((it) => {
      const followups = it.followups
        ? Object.fromEntries(
            Object.entries(it.followups).map(([key, arr]) => [key, cloneItems(arr ?? [])])
          )
        : undefined;
      return {
        ...it,
        followups,
      };
    });

  const insertHiddenItem = (
    target: Item[],
    entry: HiddenPersonalInfoEntry,
    depth: number
  ) => {
    if (depth === entry.path.length) {
      const insertAt = Math.min(entry.index, target.length);
      target.splice(insertAt, 0, cloneItems([entry.item])[0]);
      return;
    }
    const segment = entry.path[depth];
    const parent = target.find((it) => it.id === segment.parentId);
    if (!parent) {
      return;
    }
    if (!parent.followups) {
      parent.followups = {};
    }
    if (!parent.followups[segment.optionKey]) {
      parent.followups[segment.optionKey] = [];
    }
    insertHiddenItem(parent.followups[segment.optionKey]!, entry, depth + 1);
  };

  const restoreHiddenPersonalInfo = (visibleItems: Item[]): Item[] => {
    const restored = cloneItems(visibleItems);
    const sortedHidden = [...hiddenPersonalInfoRef.current].sort((a, b) => {
      if (a.path.length !== b.path.length) {
        return a.path.length - b.path.length;
      }
      for (let i = 0; i < a.path.length; i += 1) {
        const segA = a.path[i];
        const segB = b.path[i];
        if (segA.parentId !== segB.parentId) {
          return segA.parentId.localeCompare(segB.parentId);
        }
        if (segA.optionKey !== segB.optionKey) {
          return segA.optionKey.localeCompare(segB.optionKey);
        }
      }
      return a.index - b.index;
    });
    sortedHidden.forEach((entry) => {
      insertHiddenItem(restored, entry, 0);
    });
    return restored;
  };

  const extractVisibleItems = (source: Item[]): Item[] => {
    const hidden: HiddenPersonalInfoEntry[] = [];
    const traverse = (itemsToFilter: Item[], path: FollowupPathSegment[]): Item[] => {
      const result: Item[] = [];
      itemsToFilter.forEach((item, idx) => {
        if (item.type === 'personal_info') {
          hidden.push({
            path,
            index: idx,
            item: cloneItems([item])[0],
          });
          return;
        }
        let nextItem: Item = { ...item };
        if (item.followups) {
          const nextFollowupsEntries = Object.entries(item.followups).map(([key, arr]) => {
            const filtered = traverse(arr ?? [], [...path, { parentId: item.id, optionKey: key }]);
            return [key, filtered] as const;
          });
          nextItem = {
            ...nextItem,
            followups: Object.fromEntries(nextFollowupsEntries),
          };
        }
        result.push(nextItem);
      });
      return result;
    };
    const filtered = traverse(source, []);
    hiddenPersonalInfoRef.current = hidden;
    return filtered;
  };
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ id: string }[]>([]);
  const [newTemplateId, setNewTemplateId] = useState('');
  const [isAddingNewItem, setIsAddingNewItem] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, any>>({});
  // removed: postal-code lookup state in preview
  const [previewVisitType, setPreviewVisitType] = useState<'initial' | 'followup'>('initial');
  const [previewGender, setPreviewGender] = useState<'male' | 'female'>('male');
  const [previewAge, setPreviewAge] = useState<number>(30);
  const previewModal = useDisclosure();
  const imagePreviewModal = useDisclosure();
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const isInitialMount = useRef(true);
  const [isLoading, setIsLoading] = useState(true);
  const [previewFreeTexts, setPreviewFreeTexts] = useState<Record<string, string>>({});
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [initialEnabled, setInitialEnabled] = useState<boolean>(false);
  const [followupEnabled, setFollowupEnabled] = useState<boolean>(false);
  const [llmAvailable, setLlmAvailable] = useState<boolean>(false);
  const [llmStatus, setLlmStatus] = useState<LlmStatus>('disabled');
  const [llmEnabledSetting, setLlmEnabledSetting] = useState<boolean>(false);
  const [hasBaseUrl, setHasBaseUrl] = useState<boolean>(false);
  const [llmFollowupEnabled, setLlmFollowupEnabled] = useState<boolean>(true);
  const [initialLlmMax, setInitialLlmMax] = useState<number>(5);
  const [followupLlmMax, setFollowupLlmMax] = useState<number>(5);
  const isDirtyRef = useRef<boolean>(false);
  const { notify } = useNotify();
  const { confirm, prompt } = useDialog();

  const loadTemplateList = (options?: { retainSelection?: boolean }) => {
    const retainSelection = options?.retainSelection ?? false;
    return Promise.all([
      fetch('/questionnaires').then((res) => res.json()),
      fetch('/system/default-questionnaire').then((res) => res.json()),
    ]).then(([data, defaultData]) => {
      const ids = Array.from(new Set((data || []).map((t: any) => t.id))).map((id) => ({ id }));
      setTemplates(ids);
      const defaultId = defaultData?.questionnaire_id || 'default';
      setDefaultQuestionnaireId(defaultId);
      setTemplateId((prev) => {
        if (retainSelection && prev && ids.some((t) => t.id === prev)) {
          return prev;
        }
        if (ids.some((t) => t.id === defaultId)) {
          return defaultId;
        }
        return ids[0]?.id ?? null;
      });
      return ids;
    });
  };

  const uploadItemImage = async (file: File): Promise<string | undefined> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/questionnaire-item-images', { method: 'POST', body: fd });
    if (!res.ok) return undefined;
    const data = await res.json();
    return data.url as string;
  };

  const deleteItemImage = async (url?: string): Promise<void> => {
    if (!url || url.startsWith('data:')) return;
    const name = url.split('/').pop();
    if (!name) return;
    await fetch(`/questionnaire-item-images/${name}`, { method: 'DELETE' });
  };

  const confirmAndDeleteImage = async (url?: string): Promise<boolean> => {
    if (!url) return true;
    const confirmed = await confirm({
      title: '添付画像を削除しますか？',
      description: '削除すると元に戻せません。',
      confirmText: '削除する',
      cancelText: 'キャンセル',
      tone: 'danger',
    });
    if (!confirmed) return false;
    await deleteItemImage(url);
    return true;
  };

  const openImagePreview = (url: string) => {
    setImagePreviewUrl(url);
    imagePreviewModal.onOpen();
  };

  // removed: postal-code lookup handler in preview

  const closeImagePreview = () => {
    setImagePreviewUrl(null);
    imagePreviewModal.onClose();
  };

  const resetNewItemDraft = async () => {
    await deleteItemImage(newItem.image);
    setNewItem(createEmptyNewItem());
  };

  const closeNewItemModal = () => {
    void (async () => {
      await resetNewItemDraft();
      setIsAddingNewItem(false);
    })();
  };

  const markDirty = () => {
    isDirtyRef.current = true;
  };
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const addEmptyOptionToItem = (index: number) => {
    let added = false;
    setItems((prev) => {
      const target = prev[index];
      if (!target) return prev;
      const baseOptions = target.options ? [...target.options] : [];
      if (baseOptions.some((opt) => !opt.trim())) {
        return prev;
      }
      added = true;
      const next = [...prev];
      next[index] = { ...target, options: [...baseOptions, ''] } as Item;
      return next;
    });
    if (added) {
      markDirty();
    }
  };
  const addEmptyOptionToNewItem = () => {
    setNewItem((prev) => {
      if (prev.options.some((opt) => !opt.trim())) {
        return prev;
      }
      return { ...prev, options: [...prev.options, ''] };
    });
  };
  const filteredItems = useMemo(() => {
    const entries = items.map((item, index) => ({ item, index }));
    switch (itemViewFilter) {
      case 'required':
        return entries.filter(({ item }) => item.required);
      case 'initial':
        return entries.filter(({ item }) => item.use_initial);
      case 'followup':
        return entries.filter(({ item }) => item.use_followup);
      default:
        return entries;
    }
  }, [items, itemViewFilter]);

  useEffect(() => {
    if (!selectedItemId) {
      return;
    }
    if (filteredItems.some(({ item }) => item.id === selectedItemId)) {
      return;
    }
    setSelectedItemId(filteredItems[0]?.item.id ?? null);
  }, [filteredItems, selectedItemId]);

  const selectedItemIndex = selectedItemId ? items.findIndex((it) => it.id === selectedItemId) : -1;
  const selectedItem = selectedItemIndex >= 0 ? items[selectedItemIndex] : null;

  const closeItemEditor = () => {
    setSelectedItemId(null);
  };

  const renderFollowupRows = (
    followups?: Record<string, Item[]>,
    depth = 1,
    parentIdx?: number
  ): JSX.Element[] => {
    if (!followups || parentIdx === undefined) return [];
    const rows: JSX.Element[] = [];
    Object.entries(followups).forEach(([opt, fItems]) => {
      const optLabel = opt === 'yes' ? 'はい' : opt === 'no' ? 'いいえ' : opt;
      fItems.forEach((fi) => {
        const rowBg = depth === 1 ? 'teal.50' : depth === 2 ? 'teal.100' : 'teal.200';
        const rowBorder = depth === 1 ? 'teal.400' : depth === 2 ? 'teal.500' : 'teal.600';
        const hoverBg = depth === 1 ? 'teal.100' : rowBg;
        const baseIndent = 6; // 基本インデント（ドラッグハンドル列分 + α）
        const depthIndent = Math.min(depth, 4) * 6;
        const indent = baseIndent + depthIndent;
        rows.push(
          <Tr
            key={`followup-row-${fi.id}`}
            cursor={depth === 1 ? 'pointer' : undefined}
            onClick={
              depth === 1
                ? () => {
                    openFollowups(
                      (items[parentIdx].followups &&
                        items[parentIdx].followups![opt]) ||
                        [],
                      (newItems, _stack) => {
                        const f = {
                          ...(items[parentIdx].followups || {}),
                          [opt]: newItems,
                        };
                        updateItem(parentIdx, 'followups', f);
                      },
                      1,
                      { question: items[parentIdx].label, answer: optLabel }
                    );
                  }
                : undefined
            }
            bg={rowBg}
            _hover={depth === 1 ? { bg: hoverBg } : undefined}
          >
            <Td
              width="1%"
              pr={1}
              bg="inherit"
              py={3}
              borderBottomWidth="1px"
              borderBottomColor="neutral.100"
            />
            <Td colSpan={5} py={3} bg="inherit" borderBottomWidth="1px" borderBottomColor="neutral.100">
              <Flex align="center" gap={3} wrap="wrap" pl={indent}>
                <Icon as={BiGitBranch} color={rowBorder} boxSize={4} aria-label="分岐質問" />
                <Text fontSize="sm" fontWeight="semibold" color={rowBorder}>
                  [{optLabel}]
                </Text>
                <Text color="gray.700" flex="1" minW="0">
                  {fi.label}
                </Text>
                {fi.image && <Icon as={MdImage} color="gray.500" />}
              </Flex>
            </Td>
          </Tr>
        );
        if (fi.followups) {
          rows.push(...renderFollowupRows(fi.followups, depth + 1, parentIdx));
        }
      });
    });
    return rows;
  };

  // 追質問は各回答（各オプション）につき最大1件
type FollowupState = {
  items: Item[];
  depth: number;
  onSave: (items: Item[], stack: FollowupState[]) => void;
  contextPath: Array<{ question: string; answer: string }>;
};
  const [followupStack, setFollowupStack] = useState<FollowupState[]>([]);
  const followupModal = useDisclosure();

  const openFollowups = (
    items: Item[],
    onSave: (items: Item[], stack: FollowupState[]) => void,
    depth: number,
    context?: { question: string; answer: string }
  ) => {
    const initialItems =
      items.length > 0
        ? JSON.parse(JSON.stringify(items))
        : [createEmptyFollowupItem()];
    setFollowupStack((prev) => {
      const prevPath = prev.length > 0 ? prev[prev.length - 1].contextPath : [];
      const nextPath = context
        ? [...prevPath, { question: context.question, answer: context.answer }]
        : [...prevPath];
      return [
        ...prev,
        { items: initialItems, depth, onSave, contextPath: nextPath },
      ];
    });
    followupModal.onOpen();
  };

  const closeFollowups = () => {
    setFollowupStack((prev) => {
      const stack = [...prev];
      stack.pop();
      if (stack.length === 0) followupModal.onClose();
      return stack;
    });
  };

  const saveFollowups = () => {
    setFollowupStack((prev) => {
      const stack = [...prev];
      const current = stack.pop();
      if (current) current.onSave(current.items, stack);
      if (stack.length === 0) followupModal.onClose();
      return stack;
    });
  };

  const currentFollowup = followupStack[followupStack.length - 1];
  const followupContextDescription = currentFollowup?.contextPath?.length
    ? `${currentFollowup.contextPath
        .map(({ question, answer }) => `「${question}」に対して「${answer || '未入力'}」と回答されたとき`)
        .join(' → ')}の追加質問`
    : null;

  const optionDragContextRef = useRef<OptionDragContext | null>(null);

  const isSameOptionContext = (a: OptionDragContext, b: OptionDragContext) => {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'item' && b.kind === 'item') {
      return a.itemIndex === b.itemIndex;
    }
    if (a.kind === 'followup' && b.kind === 'followup') {
      return a.followupIndex === b.followupIndex;
    }
    return true;
  };

  const handleOptionDragStart = (ctx: OptionDragContext) => (event: DragEvent<HTMLElement>) => {
    optionDragContextRef.current = ctx;
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', '');
    }
  };

  const handleOptionDragOver = (ctx: OptionDragContext) => (event: DragEvent<HTMLElement>) => {
    const active = optionDragContextRef.current;
    if (!active || !isSameOptionContext(active, ctx)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  };

  const handleOptionDrop = (ctx: OptionDragContext) => (event: DragEvent<HTMLElement>) => {
    const active = optionDragContextRef.current;
    if (!active || !isSameOptionContext(active, ctx)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const from = active.optionIndex;
    const to = ctx.optionIndex;
    if (from === to) {
      optionDragContextRef.current = null;
      return;
    }
    if (ctx.kind === 'item') {
      const target = items[ctx.itemIndex];
      if (!target?.options) {
        optionDragContextRef.current = null;
        return;
      }
      updateItem(ctx.itemIndex, 'options', reorderList(target.options, from, to));
    } else if (ctx.kind === 'new') {
      setNewItem((prev) => ({
        ...prev,
        options: reorderList(prev.options, from, to),
      }));
    } else if (ctx.kind === 'followup') {
      const options = currentFollowup?.items[ctx.followupIndex]?.options;
      if (!options) {
        optionDragContextRef.current = null;
        return;
      }
      updateFollowupItem(ctx.followupIndex, 'options', reorderList(options, from, to));
    }
    optionDragContextRef.current = null;
  };

  const handleOptionDragEnd = () => {
    optionDragContextRef.current = null;
  };

  const updateFollowupItem = (index: number, field: keyof Item, value: any) => {
    if (!currentFollowup) return;
    const updated = [...currentFollowup.items];
    updated[index] = { ...updated[index], [field]: value } as Item;
    if (field === 'age_enabled') {
      if (!value) {
        updated[index].min_age = undefined;
        updated[index].max_age = undefined;
      } else {
        // デフォルト 0-110 を付与
        if (updated[index].min_age === undefined) updated[index].min_age = 0;
        if (updated[index].max_age === undefined) updated[index].max_age = 110;
      }
    }
    if (field === 'gender_enabled' && !value) {
      updated[index].gender = undefined;
    }
    setFollowupStack((prev) => {
      const stack = [...prev];
      stack[stack.length - 1] = { ...currentFollowup, items: updated };
      return stack;
    });
    markDirty();
  };

  // 年齢レンジ（追質問）を一括更新してドラッグ挙動を安定化
  const setFollowupAgeRange = (index: number, minV: number, maxV: number) => {
    if (!currentFollowup) return;
    setFollowupStack((prev) => {
      const stack = [...prev];
      const cur = stack[stack.length - 1];
      const items = [...cur.items];
      items[index] = {
        ...items[index],
        min_age: Number(minV),
        max_age: Number(maxV),
      } as Item;
      stack[stack.length - 1] = { ...cur, items };
      return stack;
    });
    markDirty();
  };

  const addEmptyOptionToFollowupItem = (index: number) => {
    let added = false;
    setFollowupStack((prev) => {
      const stack = [...prev];
      if (stack.length === 0) {
        return prev;
      }
      const cur = stack[stack.length - 1];
      const items = [...cur.items];
      const target = items[index];
      if (!target) {
        return prev;
      }
      const baseOptions = target.options ? [...target.options] : [];
      if (baseOptions.some((opt) => !opt.trim())) {
        return prev;
      }
      added = true;
      items[index] = { ...target, options: [...baseOptions, ''] } as Item;
      stack[stack.length - 1] = { ...cur, items };
      return stack;
    });
    if (added) {
      markDirty();
    }
  };

  const changeFollowupType = (index: number, newType: string) => {
    if (!currentFollowup) return;
    const target = currentFollowup.items[index];
    const next: Item = { ...target, type: newType } as Item;
    if (newType === 'multi') {
      next.allow_freetext = true;
      next.options = (target.options && target.options.length > 0) ? target.options : ['', 'その他'];
      delete (next as any).min;
      delete (next as any).max;
    } else if (newType === 'slider') {
      delete (next as any).options;
      next.allow_freetext = false;
      next.min = target.min ?? 0;
      next.max = target.max ?? 10;
    } else {
      delete (next as any).options;
      next.allow_freetext = false;
      delete (next as any).min;
      delete (next as any).max;
    }
    setFollowupStack((prev) => {
      const stack = [...prev];
      const items = [...currentFollowup.items];
      items[index] = next;
      stack[stack.length - 1] = { ...currentFollowup, items };
      return stack;
    });
    markDirty();
  };

  const createEmptyFollowupItem = (): Item => ({
    id: crypto.randomUUID(),
    label: '',
    type: 'string',
    required: false,
    options: [],
    use_initial: true,
    use_followup: true,
    allow_freetext: false,
    description: '',
    gender_enabled: false,
    gender: 'male',
    age_enabled: false,
    min_age: undefined,
    max_age: undefined,
    image: undefined,
    min: undefined,
    max: undefined,
    followups: undefined,
  });

  const removeFollowupItem = (index: number) => {
    if (!currentFollowup) return;
    setFollowupStack((prev) => {
      const stack = [...prev];
      const items = [...currentFollowup.items];
      items.splice(index, 1);
      stack[stack.length - 1] = { ...currentFollowup, items };
      return stack;
    });
    markDirty();
  };

  const [defaultQuestionnaireId, setDefaultQuestionnaireId] = useState('default');
  const [defaultSaveStatus, setDefaultSaveStatus] = useState<SaveStatus>('idle');
  const isInitialDefaultMount = useRef(true);

  useEffect(() => {
    void loadTemplateList();
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

  // 疎通チェックは Entry に限定するため、本画面は設定値とイベントで可否を決める
  useEffect(() => {
    let mounted = true;
    // 設定のみ取得（疎通はしない）
    fetch('/llm/settings')
      .then((r) => r.json())
      .then((s) => {
        if (!mounted) return;
        const enabled = !!s?.enabled;
        const base = !!s?.base_url;
        setLlmEnabledSetting(enabled);
        setHasBaseUrl(base);
        // 疎通テスト結果のみで可否を判定する（スタブ運用では base_url なしでも可）
        setLlmAvailable(llmStatus === 'ok');
        // ヘッダーのイベントを受け取れていないケースに備え、初回に現在の疎通状態を取得
        checkLlmStatus()
          .then((st) => {
            if (!mounted) return;
            setLlmStatus(st);
            setLlmAvailable(st === 'ok');
          })
          .catch(() => {
            /* noop: 取得失敗時は既存ロジックに委ねる */
          });
      })
      .catch(() => {
        if (!mounted) return;
        setLlmEnabledSetting(false);
        setHasBaseUrl(false);
        setLlmAvailable(false);
      });
    const onUpdated = (e: any) => {
      if (!mounted) return;
      const payload = e?.detail as { status?: LlmStatus } | undefined;
      const nextStatus = payload?.status ?? 'ng';
      setLlmStatus(nextStatus);
      // 疎通イベントの結果のみで判定
      setLlmAvailable(nextStatus === 'ok');
    };
    window.addEventListener('llmStatusUpdated' as any, onUpdated);
    return () => {
      mounted = false;
      window.removeEventListener('llmStatusUpdated' as any, onUpdated);
    };
  }, [llmEnabledSetting, hasBaseUrl, llmStatus]);

  // LLM が利用できない場合は追質問設定を強制オフ
  useEffect(() => {
    if (!llmAvailable) setLlmFollowupEnabled(false);
  }, [llmAvailable]);

  useEffect(() => {
    if (templateId && templates.some((t) => t.id === templateId)) {
      loadTemplates(templateId);
    } else {
      hiddenPersonalInfoRef.current = [];
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
      (init.items || []).forEach((it: any) =>
        map.set(it.id, {
          ...it,
          gender_enabled: it.gender_enabled ?? (it.gender ? true : false),
          age_enabled:
            it.age_enabled ??
            (it.min_age !== undefined || it.max_age !== undefined ? true : false),
          use_initial: true,
          use_followup: false,
        })
      );
      (follow.items || []).forEach((it: any) => {
        const merged = {
          ...it,
          gender_enabled: it.gender_enabled ?? (it.gender ? true : false),
          age_enabled:
            it.age_enabled ??
            (it.min_age !== undefined || it.max_age !== undefined ? true : false),
        };
        const exist = map.get(it.id);
        if (exist) {
          const combined: any = { ...exist, ...merged, use_initial: exist.use_initial, use_followup: true };
          // 画像など null/undefined が返る場合は既存値を優先（初診のみ設定しているケースを保持）
          if ((merged as any).image == null && (exist as any).image != null) {
            combined.image = (exist as any).image;
          }
          map.set(it.id, combined);
        } else {
          map.set(it.id, { ...merged, use_initial: false, use_followup: true });
        }
      });
      const arr = Array.from(map.values());
      const visibleItems = extractVisibleItems(arr);
      setItems(visibleItems);
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
        description: newItem.description,
        gender_enabled: newItem.gender_enabled,
        gender: newItem.gender_enabled ? newItem.gender : undefined,
        age_enabled: newItem.age_enabled,
        min_age: newItem.age_enabled ? Number(newItem.min_age || 0) : undefined,
        max_age: newItem.age_enabled ? Number(newItem.max_age || 110) : undefined,
        image: newItem.image || undefined,
        min: newItem.type === 'slider' ? Number(newItem.min) : undefined,
        max: newItem.type === 'slider' ? Number(newItem.max) : undefined,
      },
    ]);
    markDirty();
    setSelectedItemId(newId);
    setNewItem(createEmptyNewItem());
    setIsAddingNewItem(false);
  };

  const updateItem = (index: number, field: keyof Item, value: any) => {
    setItems((prev) => {
      if (index < 0 || index >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const current = next[index];
      if (!current) {
        return prev;
      }
      const updatedItem: Item = { ...current, [field]: value } as Item;
      if (field === 'age_enabled') {
        if (!value) {
          updatedItem.min_age = undefined;
          updatedItem.max_age = undefined;
        } else {
          if (updatedItem.min_age === undefined) updatedItem.min_age = 0;
          if (updatedItem.max_age === undefined) updatedItem.max_age = 110;
        }
      }
      if (field === 'gender_enabled' && !value) {
        updatedItem.gender = undefined;
      }
      next[index] = updatedItem;
      return next;
    });
    markDirty();
  };

  // 年齢レンジ（通常項目）を一括更新してドラッグ挙動を安定化
  const setItemAgeRange = (index: number, minV: number, maxV: number) => {
    setItems((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        min_age: Number(minV),
        max_age: Number(maxV),
      } as Item;
      return updated;
    });
    markDirty();
  };

  // 入力方法の変更時に、型に応じて付随プロパティを初期化する
  const changeItemType = (index: number, newType: string) => {
    setItems((prev) => {
      if (index < 0 || index >= prev.length) {
        return prev;
      }
      const updated = [...prev];
      const target = updated[index];
      if (!target) {
        return prev;
      }
      const next: Item = { ...target, type: newType } as Item;
      if (newType === 'multi') {
        // 複数選択に切り替えた場合、自由記述をデフォルトON、選択肢を最低限用意
        next.allow_freetext = true;
        next.options = (target.options && target.options.length > 0) ? target.options : ['', 'その他'];
        delete (next as any).min;
        delete (next as any).max;
      } else if (newType === 'slider') {
        delete (next as any).options;
        next.allow_freetext = false;
        next.min = target.min ?? 0;
        next.max = target.max ?? 10;
      } else {
        // それ以外に切り替えたら、選択肢系・範囲系はリセット
        delete (next as any).options;
        next.allow_freetext = false;
        delete (next as any).min;
        delete (next as any).max;
      }
      updated[index] = next;
      return updated;
    });
    markDirty();
  };

  const removeItem = async (index: number) => {
    await deleteItemImage(items[index]?.image);
    const removedId = items[index]?.id;
    const updated = items.filter((_, i) => i !== index);
    setItems(updated);
    if (removedId && removedId === selectedItemId) {
      setSelectedItemId(updated.length > 0 ? updated[0].id : null);
    }
    markDirty();
  };

  const confirmRemoveItem = async (index: number) => {
    const target = items[index];
    if (!target) return;
    const label = target.label?.trim() || '名称未設定';
    const confirmed = await confirm({
      title: `問診項目「${label}」を削除しますか？`,
      description: '削除すると元に戻せません。',
      confirmText: '削除する',
      cancelText: 'キャンセル',
      tone: 'danger',
    });
    if (!confirmed) return;
    await removeItem(index);
  };

  const saveTemplate = async () => {
    if (!templateId) return;
    // Validate: image_annotation requires image
    const allItems = restoreHiddenPersonalInfo(items);
    const missingImageErrors: string[] = [];
    const checkItem = (it: Item) => {
      const enabledInAny = !!(it.use_initial || it.use_followup);
      if (enabledInAny && it.type === 'image_annotation' && !(it.image && it.image.trim())) {
        missingImageErrors.push(`「${it.label}」に画像が設定されていません`);
      }
      if (it.followups) {
        Object.values(it.followups).forEach((children) => {
          (children || []).forEach((child) => {
            const childEnabled = !!(child.use_initial || child.use_followup || true); // followups are conditional; validate regardless
            if (childEnabled && child.type === 'image_annotation' && !(child.image && child.image.trim())) {
              missingImageErrors.push(`追質問「${child.label}」に画像が設定されていません`);
            }
          });
        });
      }
    };
    allItems.forEach(checkItem);
    if (missingImageErrors.length > 0) {
      setSaveStatus('error');
      notify({
        title: '画像が必要です',
        description: missingImageErrors[0],
        status: 'error',
        channel: 'admin',
      });
      return;
    }

    setSaveStatus('saving');
    try {
      const initialItems = allItems
        .filter((it) => it.use_initial)
        .map(({ use_initial, use_followup, description, ...rest }) => ({
          ...rest,
          ...(description ? { description } : {}),
        }));
      const followupItems = allItems
        .filter((it) => it.use_followup)
        .map(({ use_initial, use_followup, description, ...rest }) => ({
          ...rest,
          ...(description ? { description } : {}),
        }));
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
    const confirmed = await confirm({
      title: `テンプレート「${id}」を削除しますか？`,
      description: '削除すると元に戻せません。',
      confirmText: '削除する',
      cancelText: 'キャンセル',
      tone: 'danger',
    });
    if (!confirmed) return;
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
      notify({ title: 'テンプレートの削除に失敗しました。', status: 'error', channel: 'admin' });
    }
  };

  const duplicateTemplateApi = async (id: string) => {
    const result = await prompt({
      title: `テンプレート「${id}」の複製`,
      description: '複製先のテンプレートIDを入力してください。',
      initialValue: `${id}_copy`,
      confirmText: '複製する',
      cancelText: 'キャンセル',
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'IDを入力してください。';
        if (templates.some((t) => t.id === trimmed)) {
          return 'そのIDは既に使用されています。';
        }
        return null;
      },
    });
    if (result === null) return;
    const newId = result.trim();
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
      notify({ title: 'テンプレートの複製に失敗しました。', status: 'error', channel: 'admin' });
    }
  };

  const resetTemplateApi = async (id: string) => {
    const confirmed = await confirm({
      title: `テンプレート「${id}」を初期状態に戻します。`,
      description: '保存済みの内容は失われます。よろしいですか？',
      confirmText: 'リセット',
      cancelText: 'キャンセル',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await fetch(`/questionnaires/${id}/reset`, { method: 'POST' });
      notify({
        title: `テンプレート「${id}」をリセットしました。`,
        status: 'success',
        channel: 'admin',
      });
      if (templateId === id) {
        loadTemplates(id);
      }
    } catch (error) {
      console.error('Failed to reset template:', error);
      notify({ title: 'リセットに失敗しました。', status: 'error', channel: 'admin' });
    }
  };

  const handleCreateNewTemplate = () => {
    const newId = newTemplateId.trim();
    if (!newId) {
      notify({ title: 'IDを入力してください。', status: 'error', channel: 'admin' });
      return;
    }
    if (templates.some((t) => t.id === newId)) {
      notify({ title: 'そのIDは既に使用されています。', status: 'error', channel: 'admin' });
      return;
    }
    setTemplates([...templates, { id: newId }]);
    setTemplateId(newId);
    hiddenPersonalInfoRef.current = [];
    // 新規テンプレート作成時のデフォルト問診項目は「質問文形式」をベースに、
    // 発症時期は複数選択＋自由記述をあらかじめ用意する
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
        type: 'multi',
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
    if (item.gender_enabled && item.gender && item.gender !== previewGender) return false;
    if (item.age_enabled) {
      if (item.min_age !== undefined && previewAge < item.min_age) return false;
      if (item.max_age !== undefined && previewAge > item.max_age) return false;
    }
    return true;
  });
  const ItemEditorModalContent = ({ item, itemIndex }: { item: Item; itemIndex: number }): JSX.Element => (
    <VStack align="stretch" spacing={3}>
      <FormControl>
        <FormLabel m={0}>問診内容</FormLabel>
        <Input value={item.label} onChange={(e) => updateItem(itemIndex, 'label', e.target.value)} />
      </FormControl>
      <FormControl>
        <FormLabel m={0}>補足説明</FormLabel>
        <Textarea value={item.description || ''} onChange={(e) => updateItem(itemIndex, 'description', e.target.value)} />
      </FormControl>
      <FormControl>
        <FormLabel m={0}>質問時に表示する画像</FormLabel>
        {item.image && (
          <>
            <Image
              src={item.image}
              alt=""
              maxH="100px"
              mb={2}
              cursor="pointer"
              onClick={() => openImagePreview(item.image!)}
            />
            <Button
              size="xs"
              colorScheme="red"
              mb={2}
              onClick={async () => {
                const removed = await confirmAndDeleteImage(item.image);
                if (!removed) return;
                updateItem(itemIndex, 'image', undefined);
              }}
            >
              画像を削除
            </Button>
          </>
        )}
        <Input
          key={item.image || 'empty'}
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) {
              const removed = await confirmAndDeleteImage(item.image);
              if (!removed) return;
              updateItem(itemIndex, 'image', undefined);
              return;
            }
            await deleteItemImage(item.image);
            const url = await uploadItemImage(file);
            if (url) updateItem(itemIndex, 'image', url);
          }}
        />
        {item.type === 'image_annotation' && !item.image && (
          <Text color="red.500" fontSize="sm" mt={1}>画像注釈タイプでは画像が必須です</Text>
        )}
      </FormControl>
      <FormControl maxW="360px">
        <FormLabel m={0}>入力方法</FormLabel>
        <Select value={item.type} onChange={(e) => changeItemType(itemIndex, e.target.value)}>
          <option value="string">テキスト</option>
          <option value="multi">複数選択</option>
          <option value="yesno">はい/いいえ</option>
          <option value="date">日付</option>
          <option value="slider">スライドバー</option>
          <option value="image_annotation">画像注釈（タップ・線）</option>
        </Select>
      </FormControl>
      {item.type === 'multi' && (
        <Box>
          <FormLabel m={0} mb={2}>選択肢</FormLabel>
          <VStack
            align="stretch"
            onDragOver={handleOptionDragOver({ kind: 'item', itemIndex, optionIndex: item.options?.length ?? 0 })}
            onDrop={handleOptionDrop({ kind: 'item', itemIndex, optionIndex: item.options?.length ?? 0 })}
          >
            {item.options?.map((opt, optIdx) => (
              <HStack
                key={optIdx}
                spacing={2}
                align="center"
                onDragOver={handleOptionDragOver({ kind: 'item', itemIndex, optionIndex: optIdx })}
                onDrop={handleOptionDrop({ kind: 'item', itemIndex, optionIndex: optIdx })}
              >
                <Box
                  aria-label="ドラッグして順序を変更"
                  cursor="grab"
                  color="gray.500"
                  draggable
                  onDragStart={handleOptionDragStart({ kind: 'item', itemIndex, optionIndex: optIdx })}
                  onDragEnd={handleOptionDragEnd}
                  role="button"
                  tabIndex={-1}
                  lineHeight={0}
                  pr={1}
                >
                  <DragHandleIcon />
                </Box>
                <Input
                  flex="1"
                  value={opt}
                  onChange={(e) => {
                    const newOptions = [...(item.options || [])];
                    const oldVal = newOptions[optIdx];
                    newOptions[optIdx] = e.target.value;
                    updateItem(itemIndex, 'options', newOptions);
                    if (item.followups && item.followups[oldVal]) {
                      const newFollowups = { ...(item.followups || {}) };
                      newFollowups[e.target.value] = newFollowups[oldVal];
                      delete newFollowups[oldVal];
                      updateItem(itemIndex, 'followups', newFollowups);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) {
                      return;
                    }
                    const options = item.options || [];
                    if (optIdx !== options.length - 1) {
                      return;
                    }
                    if (options.some((option) => !option.trim())) {
                      return;
                    }
                    e.preventDefault();
                    addEmptyOptionToItem(itemIndex);
                  }}
                />
                <Tooltip label="追加質問を追加">
                  <IconButton
                    aria-label="追質問を追加/編集"
                    icon={<QuestionIcon />}
                    size="sm"
                    isDisabled={!opt.trim()}
                    colorScheme={item.followups && item.followups[opt] ? 'blue' : undefined}
                    onClick={() => {
                      openFollowups(
                        (item.followups && item.followups[opt]) || [],
                        (newItems, _stack) => {
                          const f = { ...(item.followups || {}), [opt]: newItems };
                          updateItem(itemIndex, 'followups', f);
                        },
                        1,
                        {
                          question: item.label,
                          answer: opt.trim() ? opt : '未設定',
                        }
                      );
                    }}
                  />
                </Tooltip>
                <IconButton
                  aria-label="選択肢を削除"
                  icon={<DeleteIcon />}
                  size="sm"
                  onClick={() => {
                    const newOptions = [...(item.options || [])];
                    const removed = newOptions.splice(optIdx, 1)[0];
                    updateItem(itemIndex, 'options', newOptions);
                    if (item.followups && item.followups[removed]) {
                      const newFollowups = { ...(item.followups || {}) };
                      delete newFollowups[removed];
                      updateItem(itemIndex, 'followups', newFollowups);
                    }
                  }}
                />
              </HStack>
            ))}
            <Checkbox
              isChecked={item.allow_freetext}
              onChange={(e) => updateItem(itemIndex, 'allow_freetext', e.target.checked)}
              alignSelf="flex-start"
            >
              フリーテキスト入力を許可
            </Checkbox>
            <Button
              size="sm"
              py={2}
              onClick={() => addEmptyOptionToItem(itemIndex)}
              isDisabled={item.options?.some((option) => !option.trim())}
              alignSelf="flex-end"
            >
              選択肢を追加
            </Button>
          </VStack>
        </Box>
      )}
      {item.type === 'yesno' && (
        <Box>
          <FormLabel m={0} mb={2}>はい/いいえ 追質問</FormLabel>
          <VStack align="stretch">
            {['yes', 'no'].map((opt) => (
              <HStack key={opt}>
                <Text w="40px">{opt === 'yes' ? 'はい' : 'いいえ'}</Text>
              <Tooltip label="追加質問を追加">
                <IconButton
                  aria-label="追質問を追加/編集"
                  icon={<QuestionIcon />}
                  size="sm"
                  colorScheme={item.followups && item.followups[opt] ? 'blue' : undefined}
                  onClick={() => {
                    const answerLabel = opt === 'yes' ? 'はい' : 'いいえ';
                    openFollowups(
                      (item.followups && item.followups[opt]) || [],
                      (newItems, _stack) => {
                        const f = { ...(item.followups || {}), [opt]: newItems };
                        updateItem(itemIndex, 'followups', f);
                      },
                      1,
                      {
                        question: item.label,
                        answer: answerLabel,
                      }
                    );
                  }}
                />
              </Tooltip>
              </HStack>
            ))}
          </VStack>
        </Box>
      )}
      {item.type === 'slider' && (
        <HStack>
          <FormControl>
            <FormLabel m={0}>最小値</FormLabel>
            <NumberInput
              value={item.min ?? 0}
              onChange={(v) => updateItem(itemIndex, 'min', v ? Number(v) : undefined)}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
          <FormControl>
            <FormLabel m={0}>最大値</FormLabel>
            <NumberInput
              value={item.max ?? 10}
              onChange={(v) => updateItem(itemIndex, 'max', v ? Number(v) : undefined)}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
        </HStack>
      )}
      <HStack spacing={4}>
        <Checkbox
          isChecked={item.required}
          onChange={(e) => updateItem(itemIndex, 'required', e.target.checked)}
        >
          必須
        </Checkbox>
        <Checkbox
          isChecked={item.use_initial}
          onChange={(e) => updateItem(itemIndex, 'use_initial', e.target.checked)}
        >
          初診
        </Checkbox>
        <Checkbox
          isChecked={item.use_followup}
          onChange={(e) => updateItem(itemIndex, 'use_followup', e.target.checked)}
        >
          再診
        </Checkbox>
      </HStack>
      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} alignItems="stretch">
        <FormControl alignSelf="flex-start">
          <Checkbox
            isChecked={item.gender_enabled}
            onChange={(e) => updateItem(itemIndex, 'gender_enabled', e.target.checked)}
          >
            性別で表示を制限
          </Checkbox>
          {item.gender_enabled && (
            <HStack mt={2}>
              <Button
                variant={item.gender === 'male' ? 'solid' : 'outline'}
                colorScheme={item.gender === 'male' ? 'teal' : 'gray'}
                onClick={() => {
                  if (!item.gender_enabled) updateItem(itemIndex, 'gender_enabled', true);
                  updateItem(itemIndex, 'gender', 'male' as any);
                }}
              >
                男性のみに質問
              </Button>
              <Button
                variant={item.gender === 'female' ? 'solid' : 'outline'}
                colorScheme={item.gender === 'female' ? 'teal' : 'gray'}
                onClick={() => {
                  if (!item.gender_enabled) updateItem(itemIndex, 'gender_enabled', true);
                  updateItem(itemIndex, 'gender', 'female' as any);
                }}
              >
                女性のみに質問
              </Button>
            </HStack>
          )}
        </FormControl>
        <FormControl alignSelf="flex-start">
          <HStack justifyContent="space-between" w="full">
            <Checkbox
              isChecked={item.age_enabled}
              onChange={(e) => updateItem(itemIndex, 'age_enabled', e.target.checked)}
            >
              年齢で表示を制限
            </Checkbox>
            {item.age_enabled && (
              <Text fontSize="sm" color="gray.600">
                {(item.min_age ?? 0)} 歳 〜 {(item.max_age ?? 110)} 歳
              </Text>
            )}
          </HStack>
          {item.age_enabled && (
            <Box px={2} mt={2} display="flex" justifyContent="center">
              <HStack w="66%" spacing={2} alignItems="center">
                <Text fontSize="sm" color="gray.600">0歳</Text>
                <RangeSlider
                  flex="1"
                  min={0}
                  max={110}
                  colorScheme="primary"
                  value={[item.min_age ?? 0, item.max_age ?? 110]}
                  onChange={(vals) => {
                    const [minV, maxV] = vals as [number, number];
                    setItemAgeRange(itemIndex, minV, maxV);
                  }}
                >
                  <RangeSliderTrack>
                    <RangeSliderFilledTrack />
                  </RangeSliderTrack>
                  <RangeSliderThumb index={0} />
                  <RangeSliderThumb index={1} />
                </RangeSlider>
                <Text fontSize="sm" color="gray.600">110歳</Text>
              </HStack>
            </Box>
          )}
        </FormControl>
      </SimpleGrid>
    </VStack>
  );

  const NewItemModalContent = (): JSX.Element => (
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
        <FormLabel>補足説明</FormLabel>
        <Textarea
          placeholder="例: わかる範囲で構いません"
          value={newItem.description}
          onChange={(e) => setNewItem({ ...newItem, description: e.target.value })}
        />
      </FormControl>
      <FormControl>
        <FormLabel>質問時に表示する画像</FormLabel>
        {newItem.image && (
          <>
            <Image
              src={newItem.image}
              alt=""
              maxH="100px"
              mb={2}
              cursor="pointer"
              onClick={() => openImagePreview(newItem.image)}
            />
            <Button
              size="xs"
              colorScheme="red"
              mb={2}
              onClick={async () => {
                const removed = await confirmAndDeleteImage(newItem.image);
                if (!removed) return;
                setNewItem({ ...newItem, image: '' });
              }}
            >
              画像を削除
            </Button>
          </>
        )}
        <Input
          key={newItem.image || 'empty'}
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) {
              const removed = await confirmAndDeleteImage(newItem.image);
              if (!removed) return;
              setNewItem({ ...newItem, image: '' });
              return;
            }
            await deleteItemImage(newItem.image);
            const url = await uploadItemImage(file);
            if (url) setNewItem({ ...newItem, image: url });
          }}
        />
        {newItem.type === 'image_annotation' && !newItem.image && (
          <Text color="red.500" fontSize="sm" mt={1}>画像注釈タイプでは画像が必須です</Text>
        )}
      </FormControl>
      <FormControl>
        <FormLabel>入力方法</FormLabel>
        <Select
          value={newItem.type}
          onChange={(e) => {
            const t = e.target.value;
            if (t === 'multi') {
              setNewItem({
                ...newItem,
                type: t,
                allow_freetext: true,
                options: newItem.options.length > 0 ? newItem.options : ['', 'その他'],
                min: '',
                max: '',
              });
            } else if (t === 'slider') {
              setNewItem({ ...newItem, type: t, allow_freetext: false, options: [], min: '0', max: '10' });
            } else {
              setNewItem({ ...newItem, type: t, allow_freetext: false, options: [], min: '', max: '' });
            }
          }}
        >
          <option value="string">テキスト</option>
          <option value="multi">複数選択</option>
          <option value="yesno">はい/いいえ</option>
          <option value="date">日付</option>
          <option value="slider">スライドバー</option>
          <option value="image_annotation">画像注釈（タップ・線）</option>
        </Select>
      </FormControl>
      {newItem.type === 'multi' && (
        <FormControl>
          <FormLabel>選択肢</FormLabel>
          <VStack
            align="stretch"
            onDragOver={handleOptionDragOver({ kind: 'new', optionIndex: newItem.options.length })}
            onDrop={handleOptionDrop({ kind: 'new', optionIndex: newItem.options.length })}
          >
            {newItem.options.map((opt, optIdx) => (
              <HStack
                key={optIdx}
                spacing={2}
                align="center"
                onDragOver={handleOptionDragOver({ kind: 'new', optionIndex: optIdx })}
                onDrop={handleOptionDrop({ kind: 'new', optionIndex: optIdx })}
              >
                <Box
                  aria-label="ドラッグして順序を変更"
                  cursor="grab"
                  color="gray.500"
                  draggable
                  onDragStart={handleOptionDragStart({ kind: 'new', optionIndex: optIdx })}
                  onDragEnd={handleOptionDragEnd}
                  role="button"
                  tabIndex={-1}
                  lineHeight={0}
                  pr={1}
                >
                  <DragHandleIcon />
                </Box>
                <Input
                  flex="1"
                  value={opt}
                  onChange={(e) => {
                    const newOptions = [...newItem.options];
                    newOptions[optIdx] = e.target.value;
                    setNewItem({ ...newItem, options: newOptions });
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) {
                      return;
                    }
                    if (optIdx !== newItem.options.length - 1) {
                      return;
                    }
                    e.preventDefault();
                    addEmptyOptionToNewItem();
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
            <Checkbox
              isChecked={newItem.allow_freetext}
              onChange={(e) => setNewItem({ ...newItem, allow_freetext: e.target.checked })}
              alignSelf="flex-start"
            >
              フリーテキスト入力を許可
            </Checkbox>
            <Button
              size="sm"
              py={2}
              onClick={addEmptyOptionToNewItem}
            >
              選択肢を追加
            </Button>
          </VStack>
        </FormControl>
      )}
      {newItem.type === 'slider' && (
        <HStack>
          <FormControl>
            <FormLabel>最小値</FormLabel>
            <NumberInput
              value={newItem.min}
              onChange={(v) => setNewItem({ ...newItem, min: v })}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
          <FormControl>
            <FormLabel>最大値</FormLabel>
            <NumberInput
              value={newItem.max}
              onChange={(v) => setNewItem({ ...newItem, max: v })}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
        </HStack>
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
      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} alignItems="stretch">
        <FormControl alignSelf="flex-start">
          <Checkbox
            isChecked={newItem.gender_enabled}
            onChange={(e) => setNewItem({ ...newItem, gender_enabled: e.target.checked })}
          >
            性別で表示を制限
          </Checkbox>
          {newItem.gender_enabled && (
            <HStack mt={2}>
              <Button
                variant={newItem.gender === 'male' ? 'solid' : 'outline'}
                colorScheme={newItem.gender === 'male' ? 'teal' : 'gray'}
                onClick={() => setNewItem({ ...newItem, gender: 'male' })}
              >
                男性のみに質問
              </Button>
              <Button
                variant={newItem.gender === 'female' ? 'solid' : 'outline'}
                colorScheme={newItem.gender === 'female' ? 'teal' : 'gray'}
                onClick={() => setNewItem({ ...newItem, gender: 'female' })}
              >
                女性のみに質問
              </Button>
            </HStack>
          )}
        </FormControl>
        <FormControl alignSelf="flex-start">
          <HStack justifyContent="space-between" w="full">
            <Checkbox
              isChecked={newItem.age_enabled}
              onChange={(e) => {
                if (e.target.checked) {
                  setNewItem({ ...newItem, age_enabled: true, min_age: String(newItem.min_age || 0), max_age: String(newItem.max_age || 110) });
                } else {
                  setNewItem({ ...newItem, age_enabled: false });
                }
              }}
            >
              年齢で表示を制限
            </Checkbox>
            {newItem.age_enabled && (
              <Text fontSize="sm" color="gray.600">
                {(newItem.min_age === '' ? 0 : parseInt(newItem.min_age, 10))} 歳 〜 {(newItem.max_age === '' ? 110 : parseInt(newItem.max_age, 10))} 歳
              </Text>
            )}
          </HStack>
          {newItem.age_enabled && (
            <Box px={2} mt={2} display="flex" justifyContent="center">
              <HStack w="66%" spacing={2} alignItems="center">
                <Text fontSize="sm" color="gray.600">0歳</Text>
                <RangeSlider
                  flex="1"
                  min={0}
                  max={110}
                  colorScheme="primary"
                  value={[
                    newItem.min_age === '' ? 0 : parseInt(newItem.min_age, 10),
                    newItem.max_age === '' ? 110 : parseInt(newItem.max_age, 10),
                  ]}
                  onChange={(vals) => {
                    const [minV, maxV] = vals as [number, number];
                    setNewItem({ ...newItem, min_age: String(minV), max_age: String(maxV) });
                  }}
                >
                  <RangeSliderTrack>
                    <RangeSliderFilledTrack />
                  </RangeSliderTrack>
                  <RangeSliderThumb index={0} />
                  <RangeSliderThumb index={1} />
                </RangeSlider>
                <Text fontSize="sm" color="gray.600">110歳</Text>
              </HStack>
            </Box>
          )}
        </FormControl>
      </SimpleGrid>
    </VStack>
  );



  return (
    <VStack spacing={8} align="stretch">
      <Box borderWidth="1px" borderRadius="md" p={4}>
        <Heading size="lg" mb={4}>
          テンプレート管理
        </Heading>
        <VStack align="stretch" spacing={6}>
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
                    {templates.map((t) => {
                      const active = t.id === templateId;
                      return (
                        <Tr
                          key={t.id}
                          bg={active ? 'bg.subtle' : 'transparent'}
                          borderLeftWidth={active ? '4px' : '0'}
                          borderLeftColor={active ? 'accent.solid' : 'transparent'}
                          _hover={{ bg: 'bg.emphasis' }}
                        >
                        <Td
                          onClick={() => setTemplateId(t.id)}
                          sx={{ cursor: 'pointer' }}
                          fontWeight={active ? 'bold' : 'normal'}
                          color={active ? 'fg.accent' : undefined}
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
                            <Button
                              size="xs"
                              colorScheme="orange"
                              variant="outline"
                              onClick={() => resetTemplateApi(t.id)}
                            >
                              リセット
                            </Button>
                            {t.id !== 'default' && (
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
                      );
                    })}
                  </Tbody>
                </Table>
              </TableContainer>
            </RadioGroup>
          </Box>
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
              プロンプトを編集
            </Checkbox>
            {followupAdvanced && (
              <Box mt={3}>
                <Text fontSize="sm" color="gray.600" mb={2}>
                  LLMは追加質問をJSON配列で返します。うまくいかないときは、プロンプトを調節してください。<br />
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
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3} mb={3}>
              <Box>
                <Checkbox
                  isChecked={initialEnabled}
                  isDisabled={!llmAvailable}
                  onChange={(e) => {
                    setInitialEnabled(e.target.checked);
                    markDirty();
                  }}
                >
                  初診
                </Checkbox>
                {initialEnabled && (
                  <FormControl mt={2}>
                    <FormLabel>初診用プロンプト</FormLabel>
                    <Textarea
                      placeholder="初診サマリーの生成方針を記述（システムプロンプト）"
                      value={initialPrompt}
                      onChange={(e) => {
                        setInitialPrompt(e.target.value);
                        markDirty();
                      }}
                      rows={6}
                    />
                  </FormControl>
                )}
              </Box>
              <Box>
                <Checkbox
                  isChecked={followupEnabled}
                  isDisabled={!llmAvailable}
                  onChange={(e) => {
                    setFollowupEnabled(e.target.checked);
                    markDirty();
                  }}
                >
                  再診
                </Checkbox>
                {followupEnabled && (
                  <FormControl mt={2}>
                    <FormLabel>再診用プロンプト</FormLabel>
                    <Textarea
                      placeholder="再診サマリーの生成方針を記述（システムプロンプト）"
                      value={followupPrompt}
                      onChange={(e) => {
                        setFollowupPrompt(e.target.value);
                        markDirty();
                      }}
                      rows={6}
                    />
                  </FormControl>
                )}
              </Box>
            </SimpleGrid>
            {!llmAvailable && (
              <Text fontSize="sm" color="gray.500">
                サマリー作成は、LLM設定が有効かつ疎通テストが成功している場合のみオンにできます。
              </Text>
            )}
          </Box>

          {/* 問診内容（ラベルのみ）の簡易一覧 */}
          <AccentOutlineBox
            p={4}
            mb={4}
            borderRadius="lg"
            bg="white"
            borderColor="neutral.200"
            boxShadow="sm"
          >
            <Flex align="center" justify="space-between" mb={3} gap={2} flexWrap="wrap">
              <Heading size="sm" color="gray.700">問診内容一覧（クリックして編集）</Heading>
              <Select
                size="sm"
                maxW="220px"
                value={itemViewFilter}
                onChange={(e) => setItemViewFilter(e.target.value as 'all' | 'required' | 'initial' | 'followup')}
                aria-label="問診内容の表示切替"
              >
                <option value="all">すべて表示</option>
                <option value="required">必須項目のみ表示</option>
                <option value="initial">初診項目のみ表示</option>
                <option value="followup">再診項目のみ表示</option>
              </Select>
            </Flex>
            {items.length === 0 ? (
              <Text color="fg.muted" fontSize="sm">項目がありません。</Text>
            ) : filteredItems.length === 0 ? (
              <Text color="fg.muted" fontSize="sm">条件に一致する項目がありません。</Text>
            ) : (
              <TableContainer overflowX="auto">
                <Table
                  size="sm"
                  minWidth="100%"
                  variant="simple"
                  sx={{
                    'tbody tr:last-of-type': { borderBottom: 'none' },
                  }}
                >
                  <Thead bg="gray.50">
                    <Tr>
                      <Th width="2.5rem">並び替え</Th>
                      <Th>問診内容</Th>
                      <Th textAlign="center" width="4.5rem">必須</Th>
                      <Th textAlign="center" width="4.5rem">初診</Th>
                      <Th textAlign="center" width="4.5rem">再診</Th>
                      <Th textAlign="right" width="5rem">削除</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {filteredItems.map(({ item, index: itemIndex }) => {
                      const selected = item.id === selectedItemId;
                      const genderRestrictionLabel = item.gender_enabled
                        ? item.gender === 'female'
                          ? '女性のみ'
                          : item.gender === 'male'
                          ? '男性のみ'
                          : '性別制限'
                        : null;
                      const ageRestrictionLabel = item.age_enabled
                        ? `${item.min_age ?? 0}〜${item.max_age ?? 110}歳`
                        : null;
                      return (
                        <Fragment key={`item-${item.id}`}>
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
                              el.style.borderTop = isTop ? '2px solid var(--chakra-colors-neutral-500)' : '';
                              el.style.borderBottom = !isTop ? '2px solid var(--chakra-colors-neutral-500)' : '';
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
                              const targetIndex = itemIndex;
                              if (targetIndex < 0) return;
                              let toIndex = targetIndex + (isTop ? 0 : 1);
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
                            bg={selected ? 'gray.100' : 'white'}
                            _hover={{ bg: selected ? 'gray.200' : 'gray.50' }}
                            borderBottomWidth="1px"
                            borderBottomColor="neutral.100"
                            sx={{ cursor: 'pointer' }}
                            onClick={() => setSelectedItemId(item.id)}
                          >
                            <Td width="1%" pr={1}>
                              <HStack spacing={1} color="gray.500">
                                <DragHandleIcon aria-label="ドラッグして並び替え" cursor="grab" />
                              </HStack>
                            </Td>
                            <Td whiteSpace="normal" wordBreak="break-word">
                              <Flex align="center" gap={2} flexWrap="wrap">
                                <Text fontWeight={selected ? 'bold' : 'normal'}>{item.label}</Text>
                                {item.followups && Object.keys(item.followups).length > 0 && (
                                  <Tooltip label="分岐質問あり" placement="top" openDelay={250}>
                                    <Badge
                                      colorScheme="teal"
                                      variant="subtle"
                                      display="inline-flex"
                                      alignItems="center"
                                      gap={1}
                                    >
                                      <Icon as={BiGitBranch} boxSize={3} aria-label="分岐質問あり" />
                                      <Box as="span" fontSize="xs">分岐</Box>
                                    </Badge>
                                  </Tooltip>
                                )}
                                {item.image && (
                                  <Icon as={MdImage} color="gray.500" boxSize={4} />
                                )}
                                {genderRestrictionLabel && (
                                  <Badge
                                    colorScheme={item.gender === 'female' ? 'pink' : item.gender === 'male' ? 'blue' : 'purple'}
                                    variant="subtle"
                                    display="inline-flex"
                                    alignItems="center"
                                    gap={1}
                                  >
                                    <Icon as={MdWc} boxSize={3} />
                                    <Box as="span" fontSize="xs">{genderRestrictionLabel}</Box>
                                  </Badge>
                                )}
                                {ageRestrictionLabel && (
                                  <Badge
                                    colorScheme="orange"
                                    variant="subtle"
                                    display="inline-flex"
                                    alignItems="center"
                                    gap={1}
                                  >
                                    <Icon as={MdCalendarToday} boxSize={3} />
                                    <Box as="span" fontSize="xs">{ageRestrictionLabel}</Box>
                                  </Badge>
                                )}
                              </Flex>
                            </Td>
                            <Td textAlign="center" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                isChecked={item.required}
                                size="md"
                                colorScheme="gray"
                                onChange={(e) => updateItem(itemIndex, 'required', e.target.checked)}
                              />
                            </Td>
                            <Td textAlign="center" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                isChecked={item.use_initial}
                                size="md"
                                colorScheme="gray"
                                onChange={(e) => updateItem(itemIndex, 'use_initial', e.target.checked)}
                              />
                            </Td>
                            <Td textAlign="center" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                isChecked={item.use_followup}
                                size="md"
                                colorScheme="gray"
                                onChange={(e) => updateItem(itemIndex, 'use_followup', e.target.checked)}
                              />
                            </Td>
                            <Td textAlign="right" onClick={(e) => e.stopPropagation()}>
                              <IconButton
                                aria-label="問診項目を削除"
                                icon={<DeleteIcon />}
                                size="sm"
                                colorScheme="red"
                                variant="solid"
                                onClick={() => {
                                  void confirmRemoveItem(itemIndex);
                                }}
                              />
                            </Td>
                          </Tr>
                          {renderFollowupRows(item.followups, 1, itemIndex)}
                        </Fragment>
                      );
                    })}
                  </Tbody>
                </Table>
              </TableContainer>
            )}
            {!isAddingNewItem && (
              <Button onClick={() => setIsAddingNewItem(true)} mt={4} colorScheme="primary">
                問診項目を追加
              </Button>
            )}
          </AccentOutlineBox>

          {/* 行内展開のため、ここでの一括編集UIは省略 */}

        </Box>
      )}

      <Modal
        isOpen={!!selectedItem}
        onClose={closeItemEditor}
        size="4xl"
        scrollBehavior="inside"
      >
        <ModalOverlay />
        <ModalContent maxW="900px">
          <ModalHeader>問診項目を編集</ModalHeader>
          <ModalCloseButton />
          {selectedItem && (
            <>
              <ModalBody>
                <ItemEditorModalContent item={selectedItem} itemIndex={selectedItemIndex} />
              </ModalBody>
              <ModalFooter>
                <Flex w="full" justify="space-between" align="center" wrap="wrap" gap={3}>
                  <Button
                    onClick={() => {
                      void confirmRemoveItem(selectedItemIndex);
                    }}
                    colorScheme="red"
                    variant="outline"
                    leftIcon={<DeleteIcon />}
                  >
                    項目を削除
                  </Button>
                  <HStack>
                    <Button onClick={closeItemEditor} variant="ghost">
                      キャンセル
                    </Button>
                    <Button onClick={closeItemEditor} colorScheme="primary">
                      保存
                    </Button>
                  </HStack>
                </Flex>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isAddingNewItem}
        onClose={closeNewItemModal}
        size="4xl"
        scrollBehavior="inside"
      >
        <ModalOverlay />
        <ModalContent maxW="900px">
          <ModalHeader>問診項目を追加</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <NewItemModalContent />
          </ModalBody>
          <ModalFooter>
            <Flex w="full" justify="flex-end" align="center" wrap="wrap" gap={3}>
              <Button onClick={closeNewItemModal} variant="ghost">
                キャンセル
              </Button>
              <Button onClick={addItem} colorScheme="primary">
                保存
              </Button>
            </Flex>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={imagePreviewModal.isOpen}
        onClose={closeImagePreview}
        size="xl"
        isCentered
      >
        <ModalOverlay />
        <ModalContent maxW="600px">
          <ModalHeader>画像プレビュー</ModalHeader>
          <ModalCloseButton />
          <ModalBody display="flex" justifyContent="center">
            {imagePreviewUrl && (
              <Image src={imagePreviewUrl} alt="プレビュー画像" maxH="70vh" objectFit="contain" />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>

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
                <FormControl mb={4}>
                  <FormLabel>性別</FormLabel>
                  <RadioGroup
                    value={previewGender}
                    onChange={(v) => {
                      setPreviewGender(v as any);
                      setPreviewAnswers({});
                    }}
                  >
                    <HStack spacing={4}>
                      <Radio value="male">男性</Radio>
                      <Radio value="female">女性</Radio>
                    </HStack>
                  </RadioGroup>
                </FormControl>
                <FormControl mb={4}>
                  <FormLabel>年齢</FormLabel>
                  <NumberInput
                    min={0}
                    value={previewAge}
                    onChange={(v) => {
                      setPreviewAge(Number(v));
                      setPreviewAnswers({});
                    }}
                  >
                    <NumberInputField />
                  </NumberInput>
                </FormControl>
                <VStack spacing={3} align="stretch">
                  {previewItems.map((item) => (
                    <Box key={item.id}>
                      <HStack align="flex-start" spacing={4}>
                        {item.image && (
                          <Image
                            src={item.image}
                            alt=""
                            boxSize="100px"
                            objectFit="contain"
                            cursor="pointer"
                            onClick={() => openImagePreview(item.image!)}
                          />
                        )}
                        <FormControl isRequired={item.required} flex="1">
                          <FormLabel>{item.label}</FormLabel>
                          {item.description && (
                            <FormHelperText mb={2}>{item.description}</FormHelperText>
                          )}
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
                          ) : item.type === 'slider' ? (
                            <>
                              <HStack spacing={4} px={2}>
                                <Text>{item.min ?? 0}</Text>
                                <Slider
                                  value={previewAnswers[item.id] ?? item.min ?? 0}
                                  min={item.min ?? 0}
                                  max={item.max ?? 10}
                                  onChange={(val) => setPreviewAnswers({ ...previewAnswers, [item.id]: val })}
                                >
                                  <SliderTrack>
                                    <SliderFilledTrack />
                                  </SliderTrack>
                                  <SliderThumb />
                                </Slider>
                                <Text>{item.max ?? 10}</Text>
                              </HStack>
                              <Box textAlign="center" mt={2}>{previewAnswers[item.id] ?? item.min ?? 0}</Box>
                            </>
                          ) : item.type === 'date' ? (
                            <DateSelect
                              value={previewAnswers[item.id] || ''}
                              onChange={(val) => setPreviewAnswers({ ...previewAnswers, [item.id]: val })}
                            />
                          ) : item.type === 'image_annotation' ? (
                            <Box>
                              <Text color="gray.500" mb={2}>画像にタップ/線でマーキング（プレビュー）</Text>
                              {item.image && (
                                <Image src={item.image} alt="" maxH="200px" objectFit="contain" />
                              )}
                            </Box>
                          ) : (
                            <Input
                              onChange={(e) => setPreviewAnswers({ ...previewAnswers, [item.id]: e.target.value })}
                              value={previewAnswers[item.id] || ''}
                            />
                          )}
                        </FormControl>
                      </HStack>
                    </Box>
                  ))}
                </VStack>
              </>
            ) : (
              <Box>プレビューする項目がありません。</Box>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
      {currentFollowup && (
        <Modal
          isOpen={followupModal.isOpen}
          onClose={closeFollowups}
          size="xl"
          scrollBehavior="inside"
        >
          <ModalOverlay />
          <ModalContent>
            <ModalHeader>追加質問の設定</ModalHeader>
            <ModalCloseButton />
            <ModalBody>
              {followupContextDescription && (
                <Alert status="info" variant="left-accent" mb={4}>
                  <AlertIcon />
                  <Box>
                    <Text fontSize="sm" color="gray.700">
                      {followupContextDescription}
                    </Text>
                  </Box>
                </Alert>
              )}
              <VStack align="stretch" spacing={4} mb={4}>
                {currentFollowup.items.map((fi, fIdx) => (
                  <Box key={fi.id} borderWidth="1px" borderRadius="md" p={3}>
                    <FormControl>
                      <FormLabel m={0}>質問文</FormLabel>
                      <Input
                        value={fi.label}
                        onChange={(e) => updateFollowupItem(fIdx, 'label', e.target.value)}
                      />
                    </FormControl>
                    <FormControl mt={2}>
                      <FormLabel m={0}>補足説明</FormLabel>
                      <Textarea
                        value={fi.description || ''}
                        onChange={(e) => updateFollowupItem(fIdx, 'description', e.target.value)}
                      />
                    </FormControl>
                    <FormControl mt={2}>
                      <FormLabel m={0}>質問時に表示する画像</FormLabel>
                      {fi.image && (
                        <>
                          <Image
                            src={fi.image}
                            alt=""
                            maxH="100px"
                            mb={2}
                            cursor="pointer"
                            onClick={() => openImagePreview(fi.image!)}
                          />
                          <Button
                            size="xs"
                            colorScheme="red"
                            mb={2}
                            onClick={async () => {
                              const removed = await confirmAndDeleteImage(fi.image);
                              if (!removed) return;
                              updateFollowupItem(fIdx, 'image', undefined);
                            }}
                          >
                            画像を削除
                          </Button>
                        </>
                      )}
                    <Input
                      key={fi.image || `empty-${fi.id}`}
                      type="file"
                      accept="image/*"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) {
                          const removed = await confirmAndDeleteImage(fi.image);
                          if (!removed) return;
                          updateFollowupItem(fIdx, 'image', undefined);
                          return;
                        }
                        await deleteItemImage(fi.image);
                        const url = await uploadItemImage(file);
                        if (url) updateFollowupItem(fIdx, 'image', url);
                      }}
                    />
                    {fi.type === 'image_annotation' && !fi.image && (
                      <Text color="red.500" fontSize="sm" mt={1}>画像注釈タイプでは画像が必須です</Text>
                    )}
                  </FormControl>
                    <FormControl mt={2} maxW="200px">
                      <FormLabel m={0}>入力方法</FormLabel>
                      <Select value={fi.type} onChange={(e) => changeFollowupType(fIdx, e.target.value)}>
                        <option value="string">テキスト</option>
                        <option value="multi">複数選択</option>
                        <option value="yesno">はい/いいえ</option>
                        <option value="date">日付</option>
                        <option value="slider">スライドバー</option>
                        <option value="image_annotation">画像注釈（タップ・線）</option>
                      </Select>
                    </FormControl>
                    {/* type-specific UI */}
                    {fi.type === 'slider' && (
                      <HStack mt={2} spacing={4}>
                        <FormControl>
                          <FormLabel m={0}>最小値</FormLabel>
                          <NumberInput
                            value={fi.min ?? 0}
                            onChange={(v) =>
                              updateFollowupItem(
                                fIdx,
                                'min',
                                v ? Number(v) : undefined
                              )
                            }
                          >
                            <NumberInputField />
                          </NumberInput>
                        </FormControl>
                        <FormControl>
                          <FormLabel m={0}>最大値</FormLabel>
                          <NumberInput
                            value={fi.max ?? 10}
                            onChange={(v) =>
                              updateFollowupItem(
                                fIdx,
                                'max',
                                v ? Number(v) : undefined
                              )
                            }
                          >
                            <NumberInputField />
                          </NumberInput>
                        </FormControl>
                      </HStack>
                    )}
                    {fi.type === 'multi' && (
                      <Box mt={2}>
                        <FormLabel m={0} mb={2}>選択肢</FormLabel>
                        <VStack
                          align="stretch"
                          onDragOver={handleOptionDragOver({ kind: 'followup', followupIndex: fIdx, optionIndex: fi.options?.length ?? 0 })}
                          onDrop={handleOptionDrop({ kind: 'followup', followupIndex: fIdx, optionIndex: fi.options?.length ?? 0 })}
                        >
                          {fi.options?.map((opt, oIdx) => (
                            <HStack
                              key={oIdx}
                              spacing={2}
                              align="center"
                              onDragOver={handleOptionDragOver({ kind: 'followup', followupIndex: fIdx, optionIndex: oIdx })}
                              onDrop={handleOptionDrop({ kind: 'followup', followupIndex: fIdx, optionIndex: oIdx })}
                            >
                              <Box
                                aria-label="ドラッグして順序を変更"
                                cursor="grab"
                                color="gray.500"
                                draggable
                                onDragStart={handleOptionDragStart({ kind: 'followup', followupIndex: fIdx, optionIndex: oIdx })}
                                onDragEnd={handleOptionDragEnd}
                                role="button"
                                tabIndex={-1}
                                lineHeight={0}
                                pr={1}
                              >
                                <DragHandleIcon />
                              </Box>
                              <Input
                                flex="1"
                                value={opt}
                                onChange={(e) => {
                                  const newOptions = [...(fi.options || [])];
                                  const oldVal = newOptions[oIdx];
                                  newOptions[oIdx] = e.target.value;
                                  updateFollowupItem(fIdx, 'options', newOptions);
                                  if (fi.followups && fi.followups[oldVal]) {
                                    const nf = { ...(fi.followups || {}) };
                                    nf[e.target.value] = nf[oldVal];
                                    delete nf[oldVal];
                                    updateFollowupItem(fIdx, 'followups', nf);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) {
                                    return;
                                  }
                                  const options = fi.options || [];
                                  if (oIdx !== options.length - 1) {
                                    return;
                                  }
                                  if (options.some((option) => !option.trim())) {
                                    return;
                                  }
                                  e.preventDefault();
                                  addEmptyOptionToFollowupItem(fIdx);
                                }}
                              />
                              <Tooltip label="追加質問を追加">
                                <IconButton
                                  aria-label="追質問を追加/編集"
                                  icon={<QuestionIcon />}
                                  size="sm"
                                  isDisabled={!opt.trim() || currentFollowup.depth >= 2}
                                  colorScheme={fi.followups && fi.followups[opt] ? 'blue' : undefined}
                                  onClick={() => {
                                    const answerLabel = opt.trim() ? opt : '未設定';
                                    openFollowups(
                                      (fi.followups && fi.followups[opt]) || [],
                                      (newItems, stack) => {
                                        const parent = stack[stack.length - 1];
                                        const items = [...parent.items];
                                        const f = {
                                          ...(items[fIdx].followups || {}),
                                          [opt]: newItems,
                                        };
                                        items[fIdx] = { ...items[fIdx], followups: f };
                                        stack[stack.length - 1] = { ...parent, items };
                                        markDirty();
                                      },
                                      currentFollowup.depth + 1,
                                      {
                                        question: fi.label,
                                        answer: answerLabel,
                                      }
                                    );
                                  }}
                                />
                              </Tooltip>
                              <IconButton
                                aria-label="選択肢を削除"
                                icon={<DeleteIcon />}
                                size="sm"
                                onClick={() => {
                                  const newOptions = [...(fi.options || [])];
                                  const removed = newOptions.splice(oIdx, 1)[0];
                                  updateFollowupItem(fIdx, 'options', newOptions);
                                  if (fi.followups && fi.followups[removed]) {
                                    const nf = { ...(fi.followups || {}) };
                                    delete nf[removed];
                                    updateFollowupItem(fIdx, 'followups', nf);
                                  }
                                }}
                              />
                            </HStack>
                          ))}
                          <Checkbox
                            isChecked={fi.allow_freetext}
                            onChange={(e) =>
                              updateFollowupItem(fIdx, 'allow_freetext', e.target.checked)
                            }
                            alignSelf="flex-start"
                          >
                            フリーテキスト入力を許可
                          </Checkbox>
                          <Button
                            size="sm"
                            py={2}
                            onClick={() => {
                              addEmptyOptionToFollowupItem(fIdx);
                            }}
                            isDisabled={fi.options?.some((o) => !o.trim())}
                            alignSelf="flex-end"
                          >
                            選択肢を追加
                          </Button>
                        </VStack>

                      </Box>
                    )}
                    {fi.type === 'yesno' && (
                      <Box mt={2}>
                        <FormLabel m={0} mb={2}>はい/いいえ 追質問</FormLabel>
                        <VStack align="stretch">
                          {['yes', 'no'].map((opt) => (
                            <HStack key={opt}>
                              <Text w="40px">{opt === 'yes' ? 'はい' : 'いいえ'}</Text>
                              <Tooltip label="追加質問を追加">
                                <IconButton
                                  aria-label="追質問を追加/編集"
                                  icon={<QuestionIcon />}
                                  size="sm"
                                  colorScheme={fi.followups && fi.followups[opt] ? 'blue' : undefined}
                                  onClick={() => {
                                    const answerLabel = opt === 'yes' ? 'はい' : 'いいえ';
                                    openFollowups(
                                      (fi.followups && fi.followups[opt]) || [],
                                      (newItems, stack) => {
                                        const parent = stack[stack.length - 1];
                                        const items = [...parent.items];
                                        const f = {
                                          ...(items[fIdx].followups || {}),
                                          [opt]: newItems,
                                        };
                                        items[fIdx] = { ...items[fIdx], followups: f };
                                        stack[stack.length - 1] = { ...parent, items };
                                        markDirty();
                                      },
                                      currentFollowup.depth + 1,
                                      {
                                        question: fi.label,
                                        answer: answerLabel,
                                      }
                                    );
                                  }}
                                />
                              </Tooltip>
                            </HStack>
                          ))}
                        </VStack>
                      </Box>
                    )}
                    {/* 必須/初診/再診（タイプ固有の設定の後に配置） */}
                    <HStack mt={2} spacing={4}>
                      <Checkbox
                        isChecked={fi.required}
                        onChange={(e) => updateFollowupItem(fIdx, 'required', e.target.checked)}
                      >
                        必須
                      </Checkbox>
                      <Checkbox
                        isChecked={fi.use_initial}
                        onChange={(e) => updateFollowupItem(fIdx, 'use_initial', e.target.checked)}
                      >
                        初診
                      </Checkbox>
                      <Checkbox
                        isChecked={fi.use_followup}
                        onChange={(e) => updateFollowupItem(fIdx, 'use_followup', e.target.checked)}
                      >
                        再診
                      </Checkbox>
                    </HStack>
                    {/* 性別制限（チェックボックス + プッシュボタン） */}
                    <FormControl mt={2} alignSelf="flex-start">
                      <Checkbox
                        isChecked={fi.gender_enabled}
                        onChange={(e) => updateFollowupItem(fIdx, 'gender_enabled', e.target.checked)}
                      >
                        性別で表示を制限
                      </Checkbox>
                      {fi.gender_enabled && (
                        <HStack spacing={4} mt={2}>
                          <Button
                            size="sm"
                            variant={fi.gender === 'male' ? 'solid' : 'outline'}
                            colorScheme={fi.gender === 'male' ? 'teal' : 'gray'}
                            onClick={() => {
                              if (!fi.gender_enabled) updateFollowupItem(fIdx, 'gender_enabled', true);
                              updateFollowupItem(fIdx, 'gender', 'male' as any);
                            }}
                          >
                            男性のみに質問
                          </Button>
                          <Button
                            size="sm"
                            variant={fi.gender === 'female' ? 'solid' : 'outline'}
                            colorScheme={fi.gender === 'female' ? 'teal' : 'gray'}
                            onClick={() => {
                              if (!fi.gender_enabled) updateFollowupItem(fIdx, 'gender_enabled', true);
                              updateFollowupItem(fIdx, 'gender', 'female' as any);
                            }}
                          >
                            女性のみに質問
                          </Button>
                        </HStack>
                      )}
                    </FormControl>
                    {/* 年齢制限（範囲スライダーに統一） */}
                    <FormControl mt={2} alignSelf="flex-start">
                      <HStack justifyContent="space-between" w="full">
                        <Checkbox
                          isChecked={fi.age_enabled}
                          onChange={(e) => updateFollowupItem(fIdx, 'age_enabled', e.target.checked)}
                        >
                          年齢で表示を制限
                        </Checkbox>
                        {fi.age_enabled && (
                          <Text fontSize="sm" color="gray.600">
                            {(fi.min_age ?? 0)} 歳 〜 {(fi.max_age ?? 110)} 歳
                          </Text>
                        )}
                      </HStack>
                      {fi.age_enabled && (
                        <Box px={2} mt={2} display="flex" justifyContent="center">
                          <HStack w="66%" spacing={2} alignItems="center">
                            <Text fontSize="sm" color="gray.600">0歳</Text>
                            <RangeSlider
                              flex="1"
                              min={0}
                              max={110}
                              colorScheme="primary"
                              value={[fi.min_age ?? 0, fi.max_age ?? 110]}
                              onChange={(vals) => {
                                const [minV, maxV] = vals as [number, number];
                                setFollowupAgeRange(fIdx, minV, maxV);
                              }}
                            >
                              <RangeSliderTrack>
                                <RangeSliderFilledTrack />
                              </RangeSliderTrack>
                              <RangeSliderThumb index={0} />
                              <RangeSliderThumb index={1} />
                            </RangeSlider>
                            <Text fontSize="sm" color="gray.600">110歳</Text>
                          </HStack>
                        </Box>
                      )}
                    </FormControl>
                  </Box>
                ))}
                <Flex w="full" justify="space-between" align="center" wrap="wrap" gap={3}>
                  <Button
                    onClick={() => removeFollowupItem(0)}
                    colorScheme="red"
                    variant="outline"
                    alignSelf="flex-start"
                    isDisabled={(currentFollowup.items?.length || 0) === 0}
                  >
                    質問を削除
                  </Button>
                  <HStack justifyContent="flex-end">
                    <Button onClick={closeFollowups} variant="ghost">
                      キャンセル
                    </Button>
                    <Button onClick={saveFollowups} colorScheme="primary">
                      保存
                    </Button>
                  </HStack>
                </Flex>
              </VStack>
            </ModalBody>
          </ModalContent>
        </Modal>
      )}
    </VStack>
  );
}
