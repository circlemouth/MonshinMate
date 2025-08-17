import { useEffect, useState } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  RadioGroup,
  HStack,
  Radio,
  Box,
} from '@chakra-ui/react';

interface Item {
  id: string;
  label: string;
  type: string;
  required: boolean;
}

/** 患者向けの問診フォーム画面。 */
export default function QuestionnaireForm() {
  const [items, setItems] = useState<Item[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [patientName, setPatientName] = useState('');
  const [dob, setDob] = useState('');
  const [visitType, setVisitType] = useState('initial');
  const [message, setMessage] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [followupQuestion, setFollowupQuestion] = useState<string | null>(null);
  const [followupItemId, setFollowupItemId] = useState<string | null>(null);
  const [followupAnswer, setFollowupAnswer] = useState<string>('');
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/questionnaires/default/template?visit_type=${visitType}`)
      .then((res) => res.json())
      .then((data) => setItems(data.items));
  }, [visitType]);

  const handleSubmit = async () => {
    const payload = {
      patient_name: patientName,
      dob,
      visit_type: visitType,
      answers,
    };
    const res = await fetch('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setMessage(data.status);
    setSessionId(data.id);
  };

  const submitFollowup = async () => {
    if (!sessionId || !followupItemId) return;
    const res = await fetch(`/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: followupItemId, answer: followupAnswer }),
    });
    const data = await res.json();
    setFollowupAnswer('');
    if (data.questions && data.questions.length > 0) {
      setFollowupQuestion(data.questions[0].text);
      setFollowupItemId(data.questions[0].id);
    } else {
      setFollowupQuestion(null);
      setFollowupItemId(null);
    }
  };

  const startFollowups = async () => {
    // 最初の起動として、主訴または onset を促す
    if (!sessionId) return;
    const res = await fetch(`/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 'chief_complaint', answer: answers['chief_complaint'] || '' }),
    });
    const data = await res.json();
    if (data.questions && data.questions.length > 0) {
      setFollowupQuestion(data.questions[0].text);
      setFollowupItemId(data.questions[0].id);
    }
  };

  const finalize = async () => {
    if (!sessionId) return;
    const res = await fetch(`/sessions/${sessionId}/finalize`, { method: 'POST' });
    const data = await res.json();
    setSummary(data.summary);
  };

  return (
    <VStack spacing={4} align="stretch">
      <FormControl>
        <FormLabel>氏名</FormLabel>
        <Input value={patientName} onChange={(e) => setPatientName(e.target.value)} />
      </FormControl>
      <FormControl>
        <FormLabel>生年月日</FormLabel>
        <Input value={dob} onChange={(e) => setDob(e.target.value)} placeholder="YYYY-MM-DD" />
      </FormControl>
      <FormControl>
        <FormLabel>受診種別</FormLabel>
        <RadioGroup onChange={setVisitType} value={visitType}>
          <HStack spacing={4}>
            <Radio value="initial">初診</Radio>
            <Radio value="followup">再診</Radio>
          </HStack>
        </RadioGroup>
      </FormControl>
      {items.map((item) => (
        <FormControl key={item.id} isRequired={item.required}>
          <FormLabel>{item.label}</FormLabel>
          <Input onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })} />
        </FormControl>
      ))}
      <Button onClick={handleSubmit} colorScheme="teal">
        送信
      </Button>
      {message && <Box>セッション: {message}</Box>}

      {sessionId && !followupQuestion && (
        <Button onClick={startFollowups} colorScheme="orange">
          追質問を開始
        </Button>
      )}

      {followupQuestion && (
        <Box borderWidth="1px" borderRadius="md" p={4}>
          <Box mb={2}>{followupQuestion}</Box>
          <Input
            placeholder="回答を入力"
            value={followupAnswer}
            onChange={(e) => setFollowupAnswer(e.target.value)}
            mb={2}
          />
          <Button onClick={submitFollowup} colorScheme="orange" mr={2}>
            送信
          </Button>
          <Button onClick={finalize} variant="outline">
            最終確認へ（確定）
          </Button>
        </Box>
      )}

      {sessionId && !followupQuestion && (
        <Button onClick={finalize} colorScheme="green">
          確定（要約を作成）
        </Button>
      )}

      {summary && (
        <Box borderWidth="1px" borderRadius="md" p={4}
          whiteSpace="pre-wrap">
          {summary}
        </Box>
      )}
    </VStack>
  );
}
