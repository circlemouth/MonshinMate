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
  FormErrorMessage,
  FormHelperText,
  Box,
  HStack,
  Image,
  Slider,
  SliderTrack,
  SliderFilledTrack,
  SliderThumb,
  Text,
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { postWithRetry } from '../retryQueue';
import ErrorSummary from '../components/ErrorSummary';
import { track } from '../metrics';
import DateSelect from '../components/DateSelect';

  interface Item {
    id: string;
    label: string;
    type: string;
    required: boolean;
    options?: string[];
    when?: { item_id: string; equals: string };
    allow_freetext?: boolean;
    description?: string;
    gender?: string;
    demographic_enabled?: boolean;
    min_age?: number;
    max_age?: number;
    min?: number;
    max?: number;
    image?: string;
    followups?: Record<string, Item[]>;
  }

const collectAllItems = (items: Item[]): Item[] => {
  const result: Item[] = [];
  const walk = (item: Item) => {
    result.push(item);
    if (item.followups) {
      Object.values(item.followups).forEach((children) =>
        children.forEach(walk)
      );
    }
  };
  items.forEach(walk);
  return result;
};

/** 患者向けの問診フォーム画面。 */
export default function QuestionnaireForm() {
  const [items, setItems] = useState<Item[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>(
    JSON.parse(sessionStorage.getItem('answers') || '{}')
  );
  const [freeTexts, setFreeTexts] = useState<Record<string, string>>({});
  const [freeTextChecks, setFreeTextChecks] = useState<Record<string, boolean>>({});
  const [sessionId] = useState<string | null>(sessionStorage.getItem('session_id'));
  const visitType = sessionStorage.getItem('visit_type') || 'initial';
  const gender = sessionStorage.getItem('gender') || '';
  const dob = sessionStorage.getItem('dob') || '';
  const age = dob ? Math.floor((Date.now() - new Date(dob).getTime()) / 31557600000) : undefined;
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionId) {
      navigate('/');
      return;
    }
      const ageParam = age !== undefined ? `&age=${age}` : '';
      fetch(`/questionnaires/default/template?visit_type=${visitType}&gender=${gender}${ageParam}`)
        .then((res) => res.json())
        .then((data) => {
          setItems(data.items);
          sessionStorage.setItem('questionnaire_items', JSON.stringify(data.items));
          const ans = { ...answers };
          data.items.forEach((it: Item) => {
            if (it.type === 'slider' && ans[it.id] === undefined) {
              ans[it.id] = it.min ?? 0;
            }
          });
          setAnswers(ans);
          sessionStorage.setItem('answers', JSON.stringify(ans));
          // 追質問を行うかどうかのフラグを保持
          sessionStorage.setItem(
            'llm_followup_enabled',
            data.llm_followup_enabled ? '1' : '0'
          );
        });
    }, [visitType, sessionId, navigate, gender, age]);

  useEffect(() => {
    const all = collectAllItems(items);
    const ft: Record<string, string> = {};
    const fc: Record<string, boolean> = {};
    all.forEach((item) => {
      if (item.type === 'multi' && item.allow_freetext) {
        const ans = answers[item.id];
        if (Array.isArray(ans)) {
          const opts = new Set(item.options || []);
          const other = ans.find((v: string) => !opts.has(v));
          if (other) {
            ft[item.id] = other;
            fc[item.id] = true;
          }
        }
      }
    });
    setFreeTexts(ft);
    setFreeTextChecks(fc);
  }, [items]);

  const [attempted, setAttempted] = useState(false);

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
    const flag = sessionStorage.getItem('llm_followup_enabled');
    const llmFollowupEnabled = flag === '1' || flag === null;
    try {
      await postWithRetry(`/sessions/${sessionId}/answers`, { answers });
      if (llmFollowupEnabled) {
        sessionStorage.setItem('answers', JSON.stringify(answers));
        navigate('/llm-wait');
      } else {
        await finalize(answers);
      }
    } catch {
      sessionStorage.setItem('answers', JSON.stringify(answers));
      await finalize(answers);
    }
  };

  const buildVisibleItems = (list: Item[]): Item[] => {
    const result: Item[] = [];
    const walk = (item: Item) => {
      if (item.demographic_enabled) {
        if (item.gender && item.gender !== 'both' && item.gender !== gender) return;
        if (item.min_age !== undefined && age !== undefined && age < item.min_age) return;
        if (item.max_age !== undefined && age !== undefined && age > item.max_age) return;
      }
      if (item.when && answers[item.when.item_id] !== item.when.equals) return;
      result.push(item);
      const ans = answers[item.id];
      if (item.followups && ans && item.followups[ans]) {
        item.followups[ans].forEach(walk);
      }
    };
    list.forEach(walk);
    return result;
  };

  const visibleItems = buildVisibleItems(items);

  const missingRequired = visibleItems.some((item) => {
    const val = answers[item.id];
    return item.required && (val === undefined || val === '' || (Array.isArray(val) && val.length === 0));
  });

  const today = new Date().toISOString().slice(0, 10);

  // よくある項目の既定補助説明（テンプレで未設定の場合のフォールバック）
  const defaultHelperTexts: Record<string, string> = {
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
    <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
    <VStack spacing={6} align="stretch">
      <ErrorSummary errors={errorsForSummary} />
      {visibleItems.map((item) => {
        const helperText = item.description || defaultHelperTexts[item.id];
        return (
          <Box key={item.id} bg="white" p={6} borderRadius="lg" boxShadow="sm">
            <FormControl
              isRequired={item.required}
              isInvalid={
                attempted &&
                item.required &&
                (answers[item.id] === undefined ||
                  answers[item.id] === '' ||
                  (Array.isArray(answers[item.id]) && answers[item.id].length === 0))
              }
            >
              <FormLabel htmlFor={`item-${item.id}`} fontSize="lg" fontWeight="bold" mb={4}>
                {item.label}
              </FormLabel>
              {helperText && (
                <FormHelperText id={`help-item-${item.id}`} mb={4}>
                  {helperText}
                </FormHelperText>
              )}
              {item.image && (
                <Image
                  src={item.image}
                  alt=""
                  w="100%"
                  maxH="400px"
                  objectFit="contain"
                  mb={4}
                />
              )}
              {item.type === 'yesno' ? (
                <RadioGroup
                  value={answers[item.id] || ''}
                  onChange={(val) => setAnswers({ ...answers, [item.id]: val })}
                  aria-describedby={helperText ? `help-item-${item.id}` : undefined}
                >
                  <VStack align="start" spacing={3}>
                    <Radio value="yes" size="lg">はい</Radio>
                      <Radio value="no" size="lg">いいえ</Radio>
                    </VStack>
                  </RadioGroup>
                ) : item.type === 'multi' && item.options ? (
                  <>
                    <CheckboxGroup
                      value={(answers[item.id] || []).filter((v: string) => v !== freeTexts[item.id])}
                      onChange={(vals) => {
                        const other = freeTextChecks[item.id] ? freeTexts[item.id] : null;
                        const newVals = other ? [...vals, other] : vals;
                        setAnswers({ ...answers, [item.id]: newVals });
                      }}
                      aria-describedby={helperText ? `help-item-${item.id}` : undefined}
                    >
                      <VStack align="start" spacing={3}>
                        {item.options.map((opt) => (
                          <Checkbox key={opt} value={opt} size="lg">
                            {opt}
                          </Checkbox>
                        ))}
                      </VStack>
                    </CheckboxGroup>
                    {item.allow_freetext && (
                      <Box mt={2}>
                        <Checkbox
                          isChecked={freeTextChecks[item.id] || false}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            const prev = freeTexts[item.id] || '';
                            const selected = (answers[item.id] || []).filter((v: string) => v !== prev);
                            const updated = checked && prev ? [...selected, prev] : selected;
                            setFreeTextChecks({ ...freeTextChecks, [item.id]: checked });
                            setAnswers({ ...answers, [item.id]: updated });
                            if (!checked) setFreeTexts({ ...freeTexts, [item.id]: '' });
                          }}
                          size="lg"
                        >
                          その他
                        </Checkbox>
                        <Input
                          mt={2}
                          placeholder="自由記述"
                          value={freeTexts[item.id] || ''}
                          onChange={(e) => {
                            const prev = freeTexts[item.id] || '';
                            const selected = (answers[item.id] || []).filter((v: string) => v !== prev);
                            const val = e.target.value;
                            const updated = freeTextChecks[item.id] && val ? [...selected, val] : selected;
                            setFreeTexts({ ...freeTexts, [item.id]: val });
                            setAnswers({ ...answers, [item.id]: updated });
                          }}
                          autoComplete="off"
                          name={`qi-free-${item.id}`}
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          isDisabled={!freeTextChecks[item.id]}
                        />
                      </Box>
                    )}
                  </>
                ) : item.type === 'slider' ? (
                  <>
                    <HStack spacing={4} px={2}>
                      <Text>{item.min ?? 0}</Text>
                      <Slider
                        value={answers[item.id] ?? item.min ?? 0}
                        min={item.min ?? 0}
                        max={item.max ?? 10}
                        onChange={(val) => setAnswers({ ...answers, [item.id]: val })}
                        aria-describedby={helperText ? `help-item-${item.id}` : undefined}
                      >
                        <SliderTrack>
                          <SliderFilledTrack />
                        </SliderTrack>
                        <SliderThumb />
                      </Slider>
                      <Text>{item.max ?? 10}</Text>
                    </HStack>
                    <Box textAlign="center" mt={2}>{answers[item.id] ?? item.min ?? 0}</Box>
                  </>
                ) : item.type === 'date' ? (
                  <DateSelect
                    value={answers[item.id] || ''}
                    onChange={(val) => setAnswers({ ...answers, [item.id]: val })}
                  />
                ) : (
                  <Input
                    id={`item-${item.id}`}
                    aria-describedby={helperText ? `help-item-${item.id}` : undefined}
                    value={answers[item.id] || ''}
                    onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })}
                    autoComplete="off"
                    name={`qi-${item.id}`}
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                )}
                <FormErrorMessage>{item.label}を入力してください</FormErrorMessage>
              </FormControl>
          </Box>
        );
      })}
      <Button onClick={handleSubmit} colorScheme="primary" size="lg" py={7} isDisabled={missingRequired}>
        次へ
      </Button>
    </VStack>
    </form>
  );
}
