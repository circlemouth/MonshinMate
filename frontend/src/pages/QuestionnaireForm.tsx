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

  useEffect(() => {
    fetch('/questionnaires/default/template?visit_type=initial')
      .then((res) => res.json())
      .then((data) => setItems(data.items));
  }, []);

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
      {message && <Box>{message}</Box>}
    </VStack>
  );
}
