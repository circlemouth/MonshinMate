import { useEffect } from 'react';
import { VStack, Spinner, Text } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';
import { refreshLlmStatus } from '../utils/llmStatus';
import { useNotify } from '../contexts/NotificationContext';

/** LLM 追質問の要否判定待機画面。 */
export default function LlmWait() {
  const navigate = useNavigate();
  const sessionId = sessionStorage.getItem('session_id');
  const { notify } = useNotify();

  const finalize = async () => {
    if (!sessionId) return;
    const err = sessionStorage.getItem('llm_error');
    sessionStorage.removeItem('pending_llm_questions');
    try {
      const res = await fetch(`/sessions/${sessionId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_error: err }),
      });
      const data = await res.json();
      sessionStorage.setItem('summary', data.summary);
    } catch (e) {
      console.error('finalize failed', e);
      postWithRetry(`/sessions/${sessionId}/finalize`, { llm_error: err });
      notify({
        title: 'ネットワークエラーが発生しました。',
        description: '接続後に再度お試しください。',
        status: 'error',
        channel: 'patient',
        actionLabel: '再試行',
        onAction: () => {
          void finalize();
        },
      });
    }
    refreshLlmStatus().catch(() => {});
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
        sessionStorage.setItem('pending_llm_questions', JSON.stringify(data.questions));
        navigate('/questions');
      } else {
        await finalize();
      }
    } catch (e) {
      console.error('llm question check failed', e);
      try {
        const msg = e instanceof Error ? e.message : String(e);
        sessionStorage.setItem('llm_error', msg);
      } catch {}
      await finalize();
    }
    refreshLlmStatus().catch(() => {});
  };
    check();
  }, [sessionId, navigate]);

  return (
    <VStack spacing={6} mt={20} align="center">
      <Spinner size="xl" color="accent.solid" />
      <Text color="fg.muted">問診内容を確認しています...</Text>
    </VStack>
  );
}
