import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { VStack, Heading, Text, Box, Button, HStack, Tag } from '@chakra-ui/react';
import { ArrowBackIcon } from '@chakra-ui/icons';
import { formatPersonalInfoLines } from '../utils/personalInfo';
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
}

interface TemplateItem {
  id: string;
  label: string;
}

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

  const formatAnswer = (itemId: string, answer: any) => {
    const itemMeta = items.find((it) => it.id === itemId);
    if (itemMeta?.type === 'personal_info') {
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

  /** サマリー文字列を改行付きで整形する。 */
  const formatSummaryText = (summary: string) => {
    return summary.replace(/^要約:\s*/, '').replace(/,\s*/g, '\n');
  };

  const questionTexts = detail.question_texts ?? {};
  const baseEntries = items.map((it) => ({
    id: it.id,
    label: questionTexts[it.id] ?? it.label,
    answer: detail.answers[it.id],
  }));
  const templateIds = new Set(items.map((it) => it.id));
  const extraIds = Array.from(
    new Set([
      ...Object.keys(questionTexts),
      ...Object.keys(detail.answers ?? {}),
    ])
  )
    .filter((id) => !templateIds.has(id) && !id.startsWith('llm_'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const additionalEntries = extraIds.map((id) => ({
    id,
    label: questionTexts[id] ?? id,
    answer: detail.answers[id],
  }));
  const questionEntries = [...baseEntries, ...additionalEntries];

  return (
    <VStack align="stretch" spacing={6}>
      <HStack justifyContent="space-between">
        <Heading size="lg">問診結果詳細</Heading>
        <Button leftIcon={<ArrowBackIcon />} onClick={() => navigate('/admin/sessions')} variant="outline">
          一覧に戻る
        </Button>
      </HStack>

      <Box borderWidth="1px" borderRadius="md" p={4}>
        <Heading size="md" mb={3}>
          患者情報
        </Heading>
        <VStack align="stretch" spacing={2}>
          <Text>
            <strong>患者名:</strong> {detail.patient_name}
          </Text>
          <Text>
            <strong>生年月日:</strong> {detail.dob}
          </Text>
          <Text>
            <strong>受診種別:</strong> {visitTypeLabel(detail.visit_type)}
          </Text>
          {/* テンプレートIDの表示は削除 */}
          <HStack spacing={2}>
            <Text>
              <strong>問診日時:</strong> {formatDate(detail.started_at ?? detail.finalized_at)}
            </Text>
            <Tag colorScheme={detail.interrupted ? "orange" : "green"} variant="subtle">
              {detail.interrupted ? "中断" : "完了"}
            </Tag>
          </HStack>

        </VStack>
      </Box>
      <VStack align="stretch" spacing={4}>
        <Heading size="md">回答内容</Heading>
        {questionEntries.map((entry) => (
          <Box key={entry.id} p={4} borderWidth="1px" borderRadius="md">
            <Text fontWeight="bold" mb={1}>
              {entry.label}
            </Text>
            {formatAnswer(entry.id, entry.answer)}
          </Box>
        ))}
      </VStack>

      {detail.llm_question_texts && Object.keys(detail.llm_question_texts).length > 0 && (
        <VStack align="stretch" spacing={4}>
          <Heading size="md">追加質問</Heading>
          {Object.entries(detail.llm_question_texts)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([qid, qtext]) => (
              <Box key={qid} p={4} borderWidth="1px" borderRadius="md" bg="gray.50">
                <Text fontWeight="bold" mb={1}>
                  {questionTexts[qid] ?? qtext}
                </Text>
                {formatAnswer(qid, detail.answers[qid])}
              </Box>
            ))}
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
