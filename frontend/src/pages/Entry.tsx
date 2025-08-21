import { VStack, FormControl, FormLabel, Input, Button, FormErrorMessage, FormHelperText, RadioGroup, HStack, Radio } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import ErrorSummary from '../components/ErrorSummary';
import { track } from '../metrics';

/** 患者名と生年月日を入力するエントリページ。 */
export default function Entry() {
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [visitType, setVisitType] = useState('');
  const [attempted, setAttempted] = useState(false);
  const navigate = useNavigate();

  const handleNext = async () => {
    setAttempted(true);
    const errs: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    if (!name) errs.push('氏名を入力してください');
    if (!dob) errs.push('生年月日を入力してください');
    if (dob && dob > today) errs.push('生年月日に未来の日付は指定できません');
    if (!visitType) errs.push('当院の受診は初めてか、選択してください');
    if (errs.length) {
      track('validation_failed', { page: 'Entry', count: errs.length });
      return;
    }
    sessionStorage.setItem('patient_name', name);
    sessionStorage.setItem('dob', dob);
    try {
      const payload = { patient_name: name, dob, visit_type: visitType, answers: {} };
      const res = await fetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      sessionStorage.setItem('session_id', data.id);
      sessionStorage.setItem('visit_type', visitType);
      navigate('/questionnaire');
    } catch (e) {
      alert('セッションの作成に失敗しました。時間をおいて再度お試しください。');
    }
  };

  // 最初のエラーへ自動フォーカス
  useEffect(() => {
    if (!attempted) return;
    const today = new Date().toISOString().slice(0, 10);
    if (!name) {
      document.getElementById('patient_name')?.focus();
      return;
    }
    if (!dob || (dob && dob > today)) {
      document.getElementById('dob')?.focus();
      return;
    }
  }, [attempted, name, dob]);

  return (
    <VStack spacing={4} align="stretch">
      <ErrorSummary
        errors={[
          ...(attempted && !name ? ['氏名を入力してください'] : []),
          ...(attempted && !dob ? ['生年月日を入力してください'] : []),
          ...(attempted && dob && dob > new Date().toISOString().slice(0, 10)
            ? ['生年月日に未来の日付は指定できません']
            : []),
          ...(attempted && !visitType ? ['当院の受診は初めてか、選択してください'] : []),
        ]}
      />
      <FormControl isRequired isInvalid={attempted && !name}>
        <FormLabel htmlFor="patient_name">氏名</FormLabel>
        <Input id="patient_name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <FormHelperText>例: 山田 太郎</FormHelperText>
        <FormErrorMessage>氏名を入力してください</FormErrorMessage>
      </FormControl>
      <FormControl
        isRequired
        isInvalid={
          attempted && (!dob || (dob && dob > new Date().toISOString().slice(0, 10)))
        }
      >
        <FormLabel htmlFor="dob">生年月日</FormLabel>
        <Input id="dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
        <FormErrorMessage>
          {dob && dob > new Date().toISOString().slice(0, 10)
            ? '生年月日に未来の日付は指定できません'
            : '生年月日を入力してください'}
        </FormErrorMessage>
      </FormControl>
      <FormControl isRequired isInvalid={attempted && !visitType}>
        <FormLabel>当院の受診は初めてですか？</FormLabel>
        <RadioGroup value={visitType} onChange={setVisitType} aria-describedby="visit-type-help">
          <HStack spacing={4}>
            <Radio value="initial">初めて</Radio>
            <Radio value="followup">受診したことがある</Radio>
          </HStack>
        </RadioGroup>
        <FormHelperText id="visit-type-help">受付スタッフの案内に従って選択してください。</FormHelperText>
        <FormErrorMessage>選択してください</FormErrorMessage>
      </FormControl>
      <Button onClick={handleNext} colorScheme="primary">
        次へ
      </Button>
    </VStack>
  );
}
