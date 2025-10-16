import { useEffect, useMemo, useState } from 'react';
import { VStack, Box, Input, Button, Heading, Divider } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';
import { refreshLlmStatus } from '../utils/llmStatus';
import { useNotify } from '../contexts/NotificationContext';

interface LlmQuestion { id: string; text: string }

/** 追加質問を一括表示してまとめて回答するページ。 */
export default function Questions() {
  const navigate = useNavigate();
  const sessionId = sessionStorage.getItem('session_id');
  const [pending, setPending] = useState<LlmQuestion[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, any>>(JSON.parse(sessionStorage.getItem('answers') || '{}'));
  const { notify } = useNotify();

  const hasQuestions = useMemo(() => pending.length > 0, [pending]);

  const finalize = async (ans: Record<string, any>) => {
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
      sessionStorage.setItem('answers', JSON.stringify(ans));
    } catch {
      sessionStorage.setItem('answers', JSON.stringify(ans));
      postWithRetry(`/sessions/${sessionId}/finalize`, { llm_error: err });
      notify({
        title: 'ネットワークエラーが発生しました。',
        description: '接続後に再度お試しください。',
        status: 'error',
        channel: 'patient',
        actionLabel: '再試行',
        onAction: () => {
          void finalize(ans);
        },
      });
    }
    refreshLlmStatus().catch(() => {});
    navigate('/done');
  };

  const fetchQuestion = async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
      if (!res.ok) throw new Error('http error');
      const data = await res.json();
      if (data.questions && data.questions.length > 0) {
        sessionStorage.setItem('pending_llm_questions', JSON.stringify(data.questions));
        setPending(data.questions);
        // 既存回答があればフォーム初期値に反映
        const initial: Record<string, string> = {};
        for (const q of data.questions as LlmQuestion[]) {
          const prev = (answers && typeof answers === 'object' ? answers[q.id] : undefined) as string | undefined;
          initial[q.id] = typeof prev === 'string' ? prev : '';
        }
        setForm(initial);
      } else {
        sessionStorage.removeItem('pending_llm_questions');
        await finalize(answers);
      }
    } catch (e) {
      console.error('fetchQuestion failed', e);
      try {
        const msg = e instanceof Error ? e.message : String(e);
        sessionStorage.setItem('llm_error', msg);
      } catch {}
      sessionStorage.removeItem('pending_llm_questions');
      await finalize(answers);
    }
    refreshLlmStatus().catch(() => {});
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
    const raw = sessionStorage.getItem('pending_llm_questions');
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) {
          setPending(arr);
          const initial: Record<string, string> = {};
          for (const q of arr as LlmQuestion[]) {
            const prev = (answers && typeof answers === 'object' ? answers[q.id] : undefined) as string | undefined;
            initial[q.id] = typeof prev === 'string' ? prev : '';
          }
          setForm(initial);
          return;
        }
      } catch {
        sessionStorage.removeItem('pending_llm_questions');
      }
    }
    fetchQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, navigate]);

  const submit = async () => {
    if (!sessionId || !hasQuestions) return;
    const toSend = pending.map((q) => ({ id: q.id, answer: form[q.id] ?? '' }));
    try {
      // すべての回答を送信（順不同で可）。ネットワーク断時はキューへ退避。
      await Promise.all(
        toSend.map((x) => postWithRetry(`/sessions/${sessionId}/llm-answers`, { item_id: x.id, answer: x.answer }))
      );
      const merged: Record<string, any> = { ...answers };
      for (const x of toSend) merged[x.id] = x.answer;
      setAnswers(merged);
      sessionStorage.setItem('answers', JSON.stringify(merged));

      // 次のバッチを取得（前回で上限到達していれば0件が返る）
      sessionStorage.removeItem('pending_llm_questions');
      const res = await fetch(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
      if (!res.ok) throw new Error('http error');
      const data = await res.json();
      if (data.questions && data.questions.length > 0) {
        sessionStorage.setItem('pending_llm_questions', JSON.stringify(data.questions));
        setPending(data.questions);
        const initial: Record<string, string> = {};
        for (const q of data.questions as LlmQuestion[]) initial[q.id] = '';
        setForm(initial);
      } else {
        await finalize(merged);
      }
    } catch (e) {
      // どれかが失敗した場合でも finalize へ（postWithRetry がキューしている）
      const merged: Record<string, any> = { ...answers };
      for (const x of toSend) merged[x.id] = x.answer;
      try {
        const msg = e instanceof Error ? e.message : String(e);
        sessionStorage.setItem('llm_error', msg);
      } catch {}
      sessionStorage.removeItem('pending_llm_questions');
      await finalize(merged);
    }
    refreshLlmStatus().catch(() => {});
  };

  return (
    <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
      <VStack spacing={5} align="stretch">
        {hasQuestions && (
          <>
            <Heading size="md">追加で確認をさせていただきます。分かる範囲でお答えください。</Heading>
            {pending.map((q, idx) => (
              <Box key={q.id}>
                <Box mb={2}>{`${idx + 1}. ${q.text}`}</Box>
                <Input
                  value={form[q.id] ?? ''}
                  onChange={(e) => setForm((m) => ({ ...m, [q.id]: e.target.value }))}
                  autoComplete="off"
                  name={`llm-answer-${q.id}`}
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                {idx < pending.length - 1 && <Divider mt={4} />}
              </Box>
            ))}
            <Button onClick={submit} colorScheme="primary">まとめて送信</Button>
          </>
        )}
      </VStack>
    </form>
  );
}
