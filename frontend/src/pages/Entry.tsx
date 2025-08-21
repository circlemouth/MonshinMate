import { VStack, FormControl, FormLabel, Input, Button, FormErrorMessage, FormHelperText } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import ErrorSummary from '../components/ErrorSummary';
import { track } from '../metrics';

/** 患者名と生年月日を入力するエントリページ。 */
export default function Entry() {
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [attempted, setAttempted] = useState(false);
  const navigate = useNavigate();

  const handleNext = () => {
    setAttempted(true);
    const errs: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    if (!name) errs.push('氏名を入力してください');
    if (!dob) errs.push('生年月日を入力してください');
    if (dob && dob > today) errs.push('生年月日に未来の日付は指定できません');
    if (errs.length) {
      track('validation_failed', { page: 'Entry', count: errs.length });
      return;
    }
    sessionStorage.setItem('patient_name', name);
    sessionStorage.setItem('dob', dob);
    navigate('/visit-type');
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
      <Button onClick={handleNext} colorScheme="primary">
        次へ
      </Button>
    </VStack>
  );
}
