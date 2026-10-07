import { finalizePatient } from '../utils/finalizePatient';
import { patientJson, patientGeneration, isPatientGeneration } from '../utils/patientSession';
import { useEffect } from 'react';
import { VStack, Spinner, Text } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';
import { useNotify } from '../contexts/NotificationContext';

/** LLM 追質問の要否判定待機画面。 */
export default function LlmWait() {
  const navigate = useNavigate();
  const sessionId = sessionStorage.getItem('session_id');
  const { notify } = useNotify();

  const finalize = async () => {
    if (!sessionId) return;
    try {
      await finalizePatient(sessionId);
      navigate('/done', { replace: true });
    } catch {
      if (sessionStorage.getItem('session_id') !== sessionId) return;
      notify({
        title: '送信完了を確認できませんでした。',
        description: '回答は消去していません。接続を確認して再試行してください。',
        status: 'error', channel: 'patient', actionLabel: '再試行', duration: null, isClosable: false,
        onAction: () => { void finalize(); },
      });
    }
  };

  useEffect(() => {
    if (!sessionId) {
      navigate('/');
      return;
    }
    const check = async () => {
    try {
      const data = await patientJson(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
      if (data.questions && data.questions.length > 0) {
        sessionStorage.setItem('pending_llm_questions', JSON.stringify(data.questions));
        navigate('/questions');
      } else {
        await finalize();
      }
    } catch (e) {
      if (sessionStorage.getItem('session_id') !== sessionId) return;
      console.error('llm question check failed', e);
      try {
        const msg = e instanceof Error ? e.message : String(e);
        sessionStorage.setItem('llm_error', msg);
      } catch {}
      await finalize();
    }
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
