import { useEffect, useState, useMemo } from 'react';
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
  Box,
  HStack,
  Text,
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';
import { track } from '../metrics';
import DateSelect from '../components/DateSelect';

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

  const printable = useMemo(() => {
    return items.map((it) => ({
      label: it.label,
      value: Array.isArray(answers[it.id])
        ? (answers[it.id] || []).join(', ')
        : answers[it.id] || '',
    }));
  }, [items, answers]);

  return (
    <VStack spacing={4} align="stretch">
      {/* 印刷用（フォーム非表示） */}
      <Box className="print-only">
        <Text as="h1" fontSize="xl" mb={4} fontWeight="bold">
          回答内容（最終確認）
        </Text>
        <VStack spacing={2} align="stretch">
          {printable.map((row, idx) => (
            <Box key={idx} borderBottom="1px solid" borderColor="neutral.300" py={2}>
              <Text fontWeight="bold" mb={1}>
                {row.label}
              </Text>
              <Text whiteSpace="pre-wrap">{row.value}</Text>
            </Box>
          ))}
        </VStack>
      </Box>

      {/* 画面用フォーム（印刷時は非表示） */}
      <Box className="print-hidden">
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
            <DateSelect
              value={answers[item.id] || ''}
              onChange={(val) => setAnswers({ ...answers, [item.id]: val })}
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
      <HStack mt={2}>
        <Button
          onClick={() => {
            track('print', { page: 'Review' });
            window.print();
          }}
          colorScheme="primary"
          variant="outline"
          className="print-hidden"
        >
          印刷プレビュー
        </Button>
        <Button onClick={finalize} colorScheme="success">
          確定する
        </Button>
      </HStack>
      </Box>
    </VStack>
  );
}
