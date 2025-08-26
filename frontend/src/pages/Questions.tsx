import { useEffect, useState } from 'react';
import { VStack, Box, Input, Button } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';

interface LlmQuestion {
  id: string;
  text: string;
}

/** 追加質問を順次表示するページ。 */
export default function Questions() {
  const navigate = useNavigate();
  const sessionId = sessionStorage.getItem('session_id');
  const [current, setCurrent] = useState<LlmQuestion | null>(null);
  const [answer, setAnswer] = useState('');
  const [answers, setAnswers] = useState<Record<string, any>>(
    JSON.parse(sessionStorage.getItem('answers') || '{}')
  );

  const finalize = async (ans: Record<string, any>) => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/sessions/${sessionId}/finalize`, { method: 'POST' });
      const data = await res.json();
      sessionStorage.setItem('summary', data.summary);
      sessionStorage.setItem('answers', JSON.stringify(ans));
    } catch {
      sessionStorage.setItem('answers', JSON.stringify(ans));
      postWithRetry(`/sessions/${sessionId}/finalize`, {});
      alert('ネットワークエラーが発生しました。接続後に再度お試しください。');
    }
    navigate('/done');
  };

  const fetchQuestion = async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
      if (!res.ok) throw new Error('http error');
      const data = await res.json();
      if (data.questions && data.questions.length > 0) {
        setCurrent({ id: data.questions[0].id, text: data.questions[0].text });
      } else {
        await finalize(answers);
      }
    } catch (e) {
      console.error('fetchQuestion failed', e);
      await finalize(answers);
    }
  };

  useEffect(() => {
    if (!sessionId) {
      navigate('/');
      return;
    }
    if (!sessionStorage.getItem('answers')) {
      navigate('/questionnaire');
      return;
    }
    fetchQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, navigate]);

  const submit = async () => {
    if (!sessionId || !current) return;
    try {
      await postWithRetry(`/sessions/${sessionId}/llm-answers`, {
        item_id: current.id,
        answer,
      });
      const newAnswers = { ...answers, [current.id]: answer };
      setAnswers(newAnswers);
      setAnswer('');
      setCurrent(null);
      const res = await fetch(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
      if (!res.ok) throw new Error('http error');
      const data = await res.json();
      if (data.questions && data.questions.length > 0) {
        setCurrent({ id: data.questions[0].id, text: data.questions[0].text });
      } else {
        await finalize(newAnswers);
      }
    } catch {
      const newAnswers = { ...answers, [current.id]: answer };
      await finalize(newAnswers);
    }
  };

  return (
    <VStack spacing={4} align="stretch">
      {current && (
        <>
          <Box>{current.text}</Box>
          <Input value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <Button onClick={submit} colorScheme="primary">
            送信
          </Button>
        </>
      )}
    </VStack>
  );
}
