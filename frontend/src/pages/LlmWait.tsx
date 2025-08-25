import { useEffect } from 'react';
import { VStack, Spinner, Text } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';

/** LLM 追質問の要否判定待機画面。 */
export default function LlmWait() {
  const navigate = useNavigate();
  const sessionId = sessionStorage.getItem('session_id');

  useEffect(() => {
    if (!sessionId) {
      navigate('/');
      return;
    }
    const check = async () => {
      try {
        const res = await fetch(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
        if (!res.ok) throw new Error('http error');
        const data = await res.json();
        if (data.questions && data.questions.length > 0) {
          navigate('/questions');
        } else {
          navigate('/review');
        }
      } catch (e) {
        console.error('llm question check failed', e);
        // 失敗時は追質問をスキップ
        navigate('/review');
      }
    };
    check();
  }, [sessionId, navigate]);

  return (
    <VStack spacing={6} mt={20} align="center">
      <Spinner size="xl" color="primary.500" />
      <Text>追加質問が必要か確認しています...</Text>
    </VStack>
  );
}
