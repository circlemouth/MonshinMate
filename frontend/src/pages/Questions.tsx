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

  const fetchQuestion = async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
      if (!res.ok) throw new Error('http error');
      const data = await res.json();
      if (data.questions && data.questions.length > 0) {
        setCurrent({ id: data.questions[0].id, text: data.questions[0].text });
      } else {
        sessionStorage.setItem('answers', JSON.stringify(answers));
        navigate('/review');
      }
    } catch (e) {
      console.error('fetchQuestion failed', e);
      sessionStorage.setItem('answers', JSON.stringify(answers));
      navigate('/review');
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
        sessionStorage.setItem('answers', JSON.stringify(newAnswers));
        navigate('/review');
      }
    } catch {
      // ネットワークエラー時は回答をキューに保存し確認画面へ遷移
      const newAnswers = { ...answers, [current.id]: answer };
      sessionStorage.setItem('answers', JSON.stringify(newAnswers));
      navigate('/review');
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
