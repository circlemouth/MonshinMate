import { useEffect } from 'react';
import { VStack, Spinner, Text } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';

/** LLM 追質問の要否判定待機画面。 */
export default function LlmWait() {
  const navigate = useNavigate();
  const sessionId = sessionStorage.getItem('session_id');

  const finalize = async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/sessions/${sessionId}/finalize`, { method: 'POST' });
      const data = await res.json();
      sessionStorage.setItem('summary', data.summary);
    } catch (e) {
      console.error('finalize failed', e);
      postWithRetry(`/sessions/${sessionId}/finalize`, {});
      alert('ネットワークエラーが発生しました。接続後に再度お試しください。');
    }
    navigate('/done');
  };

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
          await finalize();
        }
      } catch (e) {
        console.error('llm question check failed', e);
        await finalize();
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
