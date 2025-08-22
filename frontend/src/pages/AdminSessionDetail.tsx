import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { VStack, Heading, Text, Box, Button, HStack } from '@chakra-ui/react';
import { ArrowBackIcon } from '@chakra-ui/icons';

interface SessionDetail {
  id: string;
  patient_name: string;
  dob: string;
  visit_type: string;
  questionnaire_id: string;
  answers: Record<string, any>;
  summary?: string | null;
  finalized_at?: string | null;
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

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
      return;
    }
    const fetchData = async () => {
      try {
        const res = await fetch(`/admin/sessions/${id}`);
        if (!res.ok) throw new Error('Session not found');
        const data: SessionDetail = await res.json();
        setDetail(data);

        const tpl = await fetch(`/questionnaires/${data.questionnaire_id}/template?visit_type=${data.visit_type}`).then((r) => r.json());
        setItems(tpl.items);
      } catch (error) {
        console.error(error);
        navigate('/admin/sessions'); // データ取得失敗時は一覧に戻る
      }
    };
    fetchData();
  }, [id, navigate]);

  if (!detail) return null; // ローディング表示を追加しても良い

  const formatAnswer = (answer: any) => {
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
  }

  return (
    <VStack align="stretch" spacing={6}>
      <HStack justifyContent="space-between">
        <Heading size="lg">問診結果詳細</Heading>
        <Button 
          leftIcon={<ArrowBackIcon />} 
          onClick={() => navigate('/admin/sessions')}
          variant="outline"
        >
          一覧に戻る
        </Button>
      </HStack>

      <Box borderWidth="1px" borderRadius="md" p={4}>
          <Heading size="md" mb={3}>患者情報</Heading>
          <VStack align="stretch" spacing={2}>
              <Text><strong>患者名:</strong> {detail.patient_name}</Text>
              <Text><strong>生年月日:</strong> {detail.dob}</Text>
              <Text><strong>受診種別:</strong> {detail.visit_type}</Text>
              <Text><strong>テンプレートID:</strong> {detail.questionnaire_id}</Text>
              <Text><strong>確定日時:</strong> {detail.finalized_at || '-'}</Text>
          </VStack>
      </Box>

      <VStack align="stretch" spacing={4}>
        <Heading size="md">回答内容</Heading>
        {items.map((it) => (
          <Box key={it.id} p={4} borderWidth="1px" borderRadius="md">
            <Text fontWeight="bold" mb={1}>{it.label}</Text>
            {formatAnswer(detail.answers[it.id])}
          </Box>
        ))}
      </VStack>
      
      {detail.summary && (
          <VStack align="stretch" spacing={4} mt={4}>
              <Heading size="md">自動生成サマリー</Heading>
              <Box p={4} borderWidth="1px" borderRadius="md" bg="gray.50">
                  <Text whiteSpace="pre-wrap">{detail.summary}</Text>
              </Box>
          </VStack>
      )}
    </VStack>
  );
}