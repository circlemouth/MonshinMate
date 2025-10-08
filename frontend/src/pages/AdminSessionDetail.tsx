import { ReactNode, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  VStack,
  Heading,
  Text,
  Box,
  Button,
  HStack,
  Tag,
  SimpleGrid,
  Flex,
} from '@chakra-ui/react';
import { ArrowBackIcon } from '@chakra-ui/icons';
import {
  buildPersonalInfoEntries,
  formatPersonalInfoLines,
  isPersonalInfoValue,
} from '../utils/personalInfo';
import {
  flattenTemplateItems,
  hasAnswer,
  QuestionnaireTemplateItem,
} from '../utils/questionEntries';
import { useTimezone } from '../contexts/TimezoneContext';

interface SessionDetail {
  id: string;
  patient_name: string;
  dob: string;
  visit_type: string;
  questionnaire_id: string;
  answers: Record<string, any>;
  question_texts?: Record<string, string>;
  llm_question_texts?: Record<string, string>;
  summary?: string | null;
  started_at?: string | null;
  finalized_at?: string | null;
  interrupted?: boolean;
  gender?: string | null;
}

type TemplateItem = QuestionnaireTemplateItem;

const CONDITIONAL_NOTE_PATTERN = /（[^（）]*?で「[^」]+」[^（）]*?(?:選択|回答)時）$/u;

const sanitizeQuestionLabel = (label?: string | null): string => {
  if (!label) return '';
  const sanitized = label.replace(CONDITIONAL_NOTE_PATTERN, '').trimEnd();
  return sanitized.length > 0 ? sanitized : label;
};

/** 管理画面: セッション詳細。 */
export default function AdminSessionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [items, setItems] = useState<TemplateItem[]>([]);
  const { formatDate } = useTimezone();

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(`/admin/sessions/${id}`);
        if (!res.ok) throw new Error('セッションが見つかりません');
        const data: SessionDetail = await res.json();
        setDetail(data);

        const tpl = await fetch(
          `/questionnaires/${data.questionnaire_id}/template?visit_type=${data.visit_type}`
        ).then((r) => r.json());
        setItems(tpl.items);
      } catch (error) {
        console.error(error);
        navigate('/admin/sessions'); // データ取得失敗時は一覧に戻る
      }
    };
    fetchData();
  }, [id, navigate]);

  if (!detail) return null; // ローディング表示を追加しても良い

  const isPersonalInfoEntry = (
    itemId: string,
    label: string | undefined,
    value: any,
    itemType?: string
  ) => {
    if (itemType === 'personal_info') return true;
    if (itemId === 'personal_info') return true;
    if (label && label.includes('患者基本情報')) return true;
    if (isPersonalInfoValue(value)) return true;
    return false;
  };

  const formatAnswer = (itemId: string, answer: any, label?: string, itemType?: string) => {
    const itemMeta = items.find((it) => it.id === itemId);
    const effectiveType = itemType ?? itemMeta?.type;
    if (isPersonalInfoEntry(itemId, label, answer, effectiveType)) {
      const lines = formatPersonalInfoLines(answer);
      return (
        <VStack align="stretch" spacing={1}>
          {lines.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </VStack>
      );
    }
    if (answer === null || answer === undefined || answer === '') {
      return <Text color="gray.500">未回答</Text>;
    }
    if (Array.isArray(answer)) {
      return <Text>{answer.join(', ')}</Text>;
    }
    if (typeof answer === 'object') {
      return <Text as="pre" whiteSpace="pre-wrap">{JSON.stringify(answer, null, 2)}</Text>;
    }
    return <Text>{String(answer)}</Text>;
  };

  const visitTypeLabel = (type: string) => {
    switch (type) {
      case 'initial':
        return '初診';
      case 'followup':
        return '再診';
      default:
        return type;
    }
  };

  const genderLabel = (value: string) => {
    switch (value) {
      case 'male':
        return '男性';
      case 'female':
        return '女性';
      case 'other':
        return 'その他';
      default:
        return value || '未設定';
    }
  };

  /** サマリー文字列を改行付きで整形する。 */
  const formatSummaryText = (summary: string) => {
    return summary.replace(/^要約:\s*/, '').replace(/,\s*/g, '\n');
  };

  const questionTexts = detail.question_texts ?? {};
  const answers = detail.answers ?? {};
  type QuestionEntry = {
    id: string;
    label: string;
    answer: any;
    type?: string;
    isConditional?: boolean;
  };
  const flattenedItems = flattenTemplateItems(items);
  const baseEntries: QuestionEntry[] = flattenedItems
    .map((it) => ({
      id: it.id,
      label: questionTexts[it.id] ?? it.label ?? it.id,
      answer: answers[it.id],
      type: it.type,
      isConditional: it.isConditional,
    }))
    .filter(
      (entry) =>
        !isPersonalInfoEntry(entry.id, entry.label, entry.answer, entry.type) &&
        (!entry.isConditional || hasAnswer(entry.answer))
    );
  const templateIds = new Set(flattenedItems.map((it) => it.id));
  const extraIds = Array.from(
    new Set([
      ...Object.keys(questionTexts),
      ...Object.keys(detail.answers ?? {}),
    ])
  )
    .filter((id) => !templateIds.has(id) && !id.startsWith('llm_'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const additionalEntries: QuestionEntry[] = extraIds
    .map((id) => ({
      id,
      label: questionTexts[id] ?? id,
      answer: answers[id],
      type: undefined as string | undefined,
    }))
    .filter((entry) => !isPersonalInfoEntry(entry.id, entry.label, entry.answer));
  const questionEntries: QuestionEntry[] = [...baseEntries, ...additionalEntries];

  const personalInfoEntries = buildPersonalInfoEntries(detail.answers?.personal_info, {
    defaults: { name: detail.patient_name ?? '' },
    skipKeys: ['name'],
    hideEmpty: detail.visit_type !== 'initial',
  });

  type InfoItem = {
    key: string;
    label: string;
    value: ReactNode;
  };

  const normalizedPersonalEntries: InfoItem[] = personalInfoEntries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    value: entry.value && entry.value !== '' ? entry.value : '未設定',
  }));

  const statusLabel = detail.interrupted ? '中断' : '完了';
  const statusColor = detail.interrupted ? 'orange' : 'green';
  const consultationTimestamp = detail.finalized_at ?? detail.started_at;
  const consultationDateText = consultationTimestamp
    ? formatDate(consultationTimestamp)
    : '未取得';

  const patientInfoItems: InfoItem[] = [
    {
      key: 'dob',
      label: '生年月日',
      value: detail.dob && detail.dob !== '' ? detail.dob : '未設定',
    },
    {
      key: 'gender',
      label: '性別',
      value: genderLabel(detail.gender ?? ''),
    },
    {
      key: 'visitType',
      label: '受診種別',
      value: visitTypeLabel(detail.visit_type),
    },
    ...normalizedPersonalEntries,
  ];

  const renderInfoValue = (value: ReactNode) => {
    if (typeof value === 'string') {
      return (
        <Text fontSize="md" color="gray.900" _dark={{ color: 'gray.100' }}>
          {value}
        </Text>
      );
    }
    return value;
  };

  return (
    <VStack align="stretch" spacing={6}>
      <HStack justifyContent="space-between">
        <Heading size="lg">問診結果詳細</Heading>
        <Button leftIcon={<ArrowBackIcon />} onClick={() => navigate('/admin/sessions')} variant="outline">
          一覧に戻る
        </Button>
      </HStack>

      <Box borderWidth="1px" borderRadius="md" p={4}>
        <VStack align="stretch" spacing={4}>
          <Flex
            direction={{ base: 'column', md: 'row' }}
            justify="space-between"
            align={{ base: 'flex-start', md: 'flex-end' }}
            gap={3}
          >
            <Box>
              <Heading size="md" mb={1}>
                患者情報
              </Heading>
              <Text fontSize="xl" fontWeight="semibold">
                {detail.patient_name && detail.patient_name !== '' ? detail.patient_name : '未設定'}
              </Text>
            </Box>
            <VStack align={{ base: 'flex-start', md: 'flex-end' }} spacing={1}>
              <Text fontSize="sm" color="gray.500">
                問診日時
              </Text>
              <HStack spacing={2}>
                <Text fontSize="md">{consultationDateText}</Text>
                <Tag colorScheme={statusColor} variant="subtle">
                  {statusLabel}
                </Tag>
              </HStack>
            </VStack>
          </Flex>

          <SimpleGrid columns={{ base: 1, md: 2 }} spacingX={8} spacingY={3}>
            {patientInfoItems.map((item) => (
              <Box key={item.key}>
                <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase">
                  {item.label}
                </Text>
                <Box mt={1}>{renderInfoValue(item.value)}</Box>
              </Box>
            ))}
          </SimpleGrid>
        </VStack>
      </Box>
      <VStack align="stretch" spacing={4}>
        <Heading size="md">回答内容</Heading>
        {questionEntries.map((entry) => (
          <Box key={entry.id} p={4} borderWidth="1px" borderRadius="md">
            <Text fontWeight="bold" mb={1}>
              {sanitizeQuestionLabel(entry.label)}
            </Text>
            {formatAnswer(entry.id, entry.answer, entry.label, entry.type)}
          </Box>
        ))}
      </VStack>

      {detail.llm_question_texts && Object.keys(detail.llm_question_texts).length > 0 && (
        <VStack align="stretch" spacing={4}>
          <Heading size="md">追加質問</Heading>
          {Object.entries(detail.llm_question_texts)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([qid, qtext]) => {
              const originalLabel = questionTexts[qid] ?? qtext;
              return (
                <Box key={qid} p={4} borderWidth="1px" borderRadius="md" bg="gray.50">
                  <Text fontWeight="bold" mb={1}>
                    {sanitizeQuestionLabel(originalLabel)}
                  </Text>
                  {formatAnswer(qid, detail.answers[qid], originalLabel)}
                </Box>
              );
            })}
        </VStack>
      )}

      {detail.summary && (
        <VStack align="stretch" spacing={4} mt={4}>
          <Heading size="md">自動生成サマリー</Heading>
          <Box p={4} borderWidth="1px" borderRadius="md" bg="gray.50">
            <Text whiteSpace="pre-wrap">{formatSummaryText(detail.summary)}</Text>
          </Box>
        </VStack>
      )}
    </VStack>
  );
}
