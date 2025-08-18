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
  Radio,
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';

interface Item {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

/** 全回答を確認しインライン編集後に確定するページ。 */
export default function Review() {
  const navigate = useNavigate();
  const sessionId = sessionStorage.getItem('session_id');
  const [items] = useState<Item[]>(
    JSON.parse(sessionStorage.getItem('questionnaire_items') || '[]')
  );
  const [answers, setAnswers] = useState<Record<string, any>>(
    JSON.parse(sessionStorage.getItem('answers') || '{}')
  );

  useEffect(() => {
    if (!sessionId) {
      navigate('/');
      return;
    }
    if (!sessionStorage.getItem('answers')) {
      navigate('/questionnaire');
    }
  }, [navigate, sessionId]);

  const finalize = async () => {
    if (!sessionId) return;
    try {
      await postWithRetry(`/sessions/${sessionId}/answers`, { answers });
      const res = await fetch(`/sessions/${sessionId}/finalize`, { method: 'POST' });
      const data = await res.json();
      sessionStorage.setItem('summary', data.summary);
      sessionStorage.setItem('answers', JSON.stringify(answers));
      navigate('/done');
    } catch {
      // 確定リクエストが送信できない場合はキューに保存済み回答を保持
      sessionStorage.setItem('answers', JSON.stringify(answers));
      alert('ネットワークエラーが発生しました。接続後に再度お試しください。');
    }
  };

  return (
    <VStack spacing={4} align="stretch">
      {items.map((item) => (
        <FormControl key={item.id} isRequired={item.required}>
          <FormLabel>{item.label}</FormLabel>
          {item.type === 'number' ? (
            <Input
              type="number"
              value={answers[item.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })}
            />
          ) : item.type === 'date' ? (
            <Input
              type="date"
              value={answers[item.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })}
            />
          ) : item.type === 'single' && item.options ? (
            <RadioGroup
              value={answers[item.id] || ''}
              onChange={(val) => setAnswers({ ...answers, [item.id]: val })}
            >
              <VStack align="start">
                {item.options.map((opt) => (
                  <Radio key={opt} value={opt}>
                    {opt}
                  </Radio>
                ))}
              </VStack>
            </RadioGroup>
          ) : item.type === 'multi' && item.options ? (
            <CheckboxGroup
              value={answers[item.id] || []}
              onChange={(vals) => setAnswers({ ...answers, [item.id]: vals })}
            >
              <VStack align="start">
                {item.options.map((opt) => (
                  <Checkbox key={opt} value={opt}>
                    {opt}
                  </Checkbox>
                ))}
              </VStack>
            </CheckboxGroup>
          ) : (
            <Input
              value={answers[item.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })}
            />
          )}
        </FormControl>
      ))}
      <Button onClick={finalize} colorScheme="green">
        確定する
      </Button>
    </VStack>
  );
}
