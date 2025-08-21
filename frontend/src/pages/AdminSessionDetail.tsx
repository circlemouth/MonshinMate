import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { VStack, Heading, Text, Box } from '@chakra-ui/react';

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
      const res = await fetch(`/admin/sessions/${id}`);
      const data: SessionDetail = await res.json();
      setDetail(data);
      const tpl = await fetch(`/questionnaires/${data.questionnaire_id}/template?visit_type=${data.visit_type}`).then((r) => r.json());
      setItems(tpl.items);
    };
    fetchData();
  }, [id, navigate]);

  if (!detail) return null;

  return (
    <VStack align="stretch" spacing={4}>
      <Heading size="md">{detail.patient_name} の問診結果</Heading>
      {items.map((it) => (
        <Box key={it.id} p={2} borderWidth="1px" borderRadius="md">
          <Text fontWeight="bold">{it.label}</Text>
          <Text>{detail.answers[it.id] ?? '未回答'}</Text>
        </Box>
      ))}
    </VStack>
  );
}
