import { useEffect, useState } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  Checkbox,
  CheckboxGroup,
  RadioGroup,
  HStack,
  Radio,
  FormErrorMessage,
  FormHelperText,
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';
import ErrorSummary from '../components/ErrorSummary';
import { track } from '../metrics';

interface Item {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  when?: { item_id: string; equals: string };
}

/** 患者向けの問診フォーム画面。 */
export default function QuestionnaireForm() {
  const [items, setItems] = useState<Item[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>(
    JSON.parse(sessionStorage.getItem('answers') || '{}')
  );
  const [sessionId] = useState<string | null>(sessionStorage.getItem('session_id'));
  const visitType = sessionStorage.getItem('visit_type') || 'initial';
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionId) {
      navigate('/');
      return;
    }
    fetch(`/questionnaires/default/template?visit_type=${visitType}`)
      .then((res) => res.json())
      .then((data) => {
        setItems(data.items);
        sessionStorage.setItem('questionnaire_items', JSON.stringify(data.items));
      });
  }, [visitType, sessionId, navigate]);

  const [attempted, setAttempted] = useState(false);

  const handleSubmit = async () => {
    if (!sessionId) return;
    setAttempted(true);
    // 必須チェック
    const requiredErrors = visibleItems
      .filter((item) => item.required)
      .filter((item) => {
        const val = answers[item.id];
        return val === undefined || val === '' || (Array.isArray(val) && val.length === 0);
      });
    if (requiredErrors.length > 0) {
      track('validation_failed', { page: 'Questionnaire', count: requiredErrors.length });
      return;
    }
    try {
      await postWithRetry(`/sessions/${sessionId}/answers`, { answers });
      sessionStorage.setItem('answers', JSON.stringify(answers));
      const res = await fetch(`/sessions/${sessionId}/llm-questions`, { method: 'POST' });
      const data = await res.json();
      if (data.questions && data.questions.length > 0) {
        navigate('/questions');
      } else {
        navigate('/review');
      }
    } catch {
      // ネットワークエラー時は回答をキューに保存し確認画面へ遷移
      sessionStorage.setItem('answers', JSON.stringify(answers));
      navigate('/review');
    }
  };

  const visibleItems = items.filter((item) => {
    if (!item.when) return true;
    return answers[item.when.item_id] === item.when.equals;
  });

  const missingRequired = visibleItems.some((item) => {
    const val = answers[item.id];
    return item.required && (val === undefined || val === '' || (Array.isArray(val) && val.length === 0));
  });

  const today = new Date().toISOString().slice(0, 10);

  // よくある項目の補助説明（テンプレに依存せず表示可能な範囲のみ）
  const helperTexts: Record<string, string> = {
    chief_complaint: 'できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。',
    onset: 'わかる範囲で構いません（例：今朝から、1週間前から など）。',
  };

  const errorsForSummary = attempted
    ? visibleItems
        .filter((item) => item.required)
        .filter((item) => {
          const val = answers[item.id];
          return val === undefined || val === '' || (Array.isArray(val) && val.length === 0);
        })
        .map((item) => `${item.label}を入力してください`)
    : [];

  // エラー時は最初の未入力必須項目へフォーカス＆スクロール
  useEffect(() => {
    if (!attempted) return;
    const firstInvalid = visibleItems.find((item) => {
      if (!item.required) return false;
      const val = answers[item.id];
      return val === undefined || val === '' || (Array.isArray(val) && val.length === 0);
    });
    if (firstInvalid) {
      const el = document.getElementById(`item-${firstInvalid.id}`) as HTMLElement | null;
      if (el) {
        el.focus();
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [attempted, visibleItems, answers]);

  return (
    <VStack spacing={4} align="stretch">
      <ErrorSummary errors={errorsForSummary} />
      {visibleItems.map((item) => (
        <FormControl
          key={item.id}
          isRequired={item.required}
          isInvalid={
            attempted && item.required && (answers[item.id] === undefined || answers[item.id] === '' || (Array.isArray(answers[item.id]) && answers[item.id].length === 0))
          }
        >
          <FormLabel htmlFor={`item-${item.id}`}>{item.label}</FormLabel>
          {helperTexts[item.id] && (
            <FormHelperText id={`help-item-${item.id}`}>{helperTexts[item.id]}</FormHelperText>
          )}
          {item.type === 'number' ? (
            <Input
              type="number"
              inputMode="numeric"
              id={`item-${item.id}`}
              aria-describedby={helperTexts[item.id] ? `help-item-${item.id}` : undefined}
              value={answers[item.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })}
            />
          ) : item.type === 'date' ? (
            <Input
              type="date"
              max={today}
              id={`item-${item.id}`}
              aria-describedby={helperTexts[item.id] ? `help-item-${item.id}` : undefined}
              value={answers[item.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })}
            />
          ) : item.type === 'single' && item.options ? (
            <RadioGroup
              value={answers[item.id] || ''}
              onChange={(val) => setAnswers({ ...answers, [item.id]: val })}
              aria-describedby={helperTexts[item.id] ? `help-item-${item.id}` : undefined}
            >
              <VStack align="start">
                {item.options.map((opt) => (
                  <Radio key={opt} value={opt} size="lg">
                    {opt}
                  </Radio>
                ))}
              </VStack>
            </RadioGroup>
          ) : item.type === 'multi' && item.options ? (
            <CheckboxGroup
              value={answers[item.id] || []}
              onChange={(vals) => setAnswers({ ...answers, [item.id]: vals })}
              aria-describedby={helperTexts[item.id] ? `help-item-${item.id}` : undefined}
            >
              <VStack align="start">
                {item.options.map((opt) => (
                  <Checkbox key={opt} value={opt} size="lg">
                    {opt}
                  </Checkbox>
                ))}
              </VStack>
            </CheckboxGroup>
          ) : (
            <Input
              id={`item-${item.id}`}
              aria-describedby={helperTexts[item.id] ? `help-item-${item.id}` : undefined}
              value={answers[item.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })}
            />
          )}
          <FormErrorMessage>{item.label}を入力してください</FormErrorMessage>
        </FormControl>
      ))}
      <Button onClick={handleSubmit} colorScheme="primary" isDisabled={missingRequired}>
        次へ
      </Button>
    </VStack>
  );
}
