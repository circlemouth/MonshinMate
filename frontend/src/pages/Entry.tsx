import { VStack, FormControl, FormLabel, Input, Button, FormErrorMessage, FormHelperText, RadioGroup, HStack, Radio, Select, Flex, Box } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import ErrorSummary from '../components/ErrorSummary';
import { track } from '../metrics';

/** 患者名と生年月日を入力するエントリページ。 */
export default function Entry() {
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('');
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 120 }, (_, i) => thisYear - i); // 過去120年分
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const [dobYear, setDobYear] = useState<number | ''>('');
  const [dobMonth, setDobMonth] = useState<number | ''>('');
  const [dobDay, setDobDay] = useState<number | ''>('');

  const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
  const maxDay = typeof dobYear === 'number' && typeof dobMonth === 'number' ? daysInMonth(dobYear, dobMonth) : 31;
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);

  // 年月日セレクトの変更に合わせて ISO 形式 (YYYY-MM-DD) を生成
  useEffect(() => {
    if (dobYear && dobMonth && dobDay) {
      const mm = String(dobMonth).padStart(2, '0');
      const dd = String(Math.min(dobDay, daysInMonth(dobYear, dobMonth))).padStart(2, '0');
      setDob(`${dobYear}-${mm}-${dd}`);
    } else {
      setDob('');
    }
  }, [dobYear, dobMonth, dobDay]);
  const [visitType, setVisitType] = useState('');
  const [attempted, setAttempted] = useState(false);
  const navigate = useNavigate();

  const handleNext = async () => {
    setAttempted(true);
    const errs: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    if (!name) errs.push('氏名を入力してください');
    if (!gender) errs.push('性別を選択してください');
    if (!dob) errs.push('生年月日を入力してください');
    if (dob && dob > today) errs.push('生年月日に未来の日付は指定できません');
    if (!visitType) errs.push('当院の受診は初めてか、選択してください');
    if (errs.length) {
      track('validation_failed', { page: 'Entry', count: errs.length });
      return;
    }
    sessionStorage.setItem('patient_name', name);
    sessionStorage.setItem('dob', dob);
    sessionStorage.setItem('gender', gender);
    try {
      const payload = { patient_name: name, dob, gender, visit_type: visitType, answers: {} };
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
    if (!gender) {
      document.getElementsByName('gender')?.[0]?.focus();
      return;
    }
    if (!dob || (dob && dob > today)) {
      // 年→月→日の順にフォーカス
      if (!dobYear) {
        document.getElementById('dob-year')?.focus();
        return;
      }
      if (!dobMonth) {
        document.getElementById('dob-month')?.focus();
        return;
      }
      document.getElementById('dob-day')?.focus();
      return;
    }
  }, [attempted, name, dob, gender]);

  return (
    <VStack spacing={4} align="stretch">
      <ErrorSummary
        errors={[
          ...(attempted && !name ? ['氏名を入力してください'] : []),
          ...(attempted && !gender ? ['性別を選択してください'] : []),
          ...(attempted && !dob ? ['生年月日を入力してください'] : []),
          ...(attempted && dob && dob > new Date().toISOString().slice(0, 10)
            ? ['生年月日に未来の日付は指定できません']
            : []),
          ...(attempted && !visitType ? ['当院の受診は初めてか、選択してください'] : []),
        ]}
      />
      <FormControl isRequired isInvalid={attempted && !name}>
        <HStack alignItems="center">
          <FormLabel htmlFor="patient_name" mb={0} w="100px">氏名</FormLabel>
          <Input id="patient_name" placeholder="問診　太郎" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </HStack>
        <FormErrorMessage ml="116px">氏名を入力してください</FormErrorMessage>
      </FormControl>
      <FormControl isRequired isInvalid={attempted && !gender}>
        <HStack alignItems="center">
          <FormLabel mb={0} w="100px">性別</FormLabel>
          <RadioGroup value={gender} onChange={setGender}>
            <HStack spacing={4}>
              <Radio value="male" name="gender">男</Radio>
              <Radio value="female" name="gender">女</Radio>
            </HStack>
          </RadioGroup>
        </HStack>
        <FormErrorMessage ml="116px">性別を選択してください</FormErrorMessage>
      </FormControl>
      <FormControl
        isRequired
        isInvalid={
          attempted && (!dob || (dob && dob > new Date().toISOString().slice(0, 10)))
        }
      >
        <HStack alignItems="center">
          <FormLabel mb={0} w="100px">生年月日</FormLabel>
          <HStack flex={1}>
            <Select id="dob-year" placeholder="年" value={dobYear}
                    onChange={(e) => setDobYear(e.target.value ? Number(e.target.value) : '')}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
            <Select id="dob-month" placeholder="月" value={dobMonth}
                    onChange={(e) => setDobMonth(e.target.value ? Number(e.target.value) : '')}>
              {months.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
            <Select id="dob-day" placeholder="日" value={dobDay}
                    onChange={(e) => setDobDay(e.target.value ? Number(e.target.value) : '')}
                    isDisabled={!dobYear || !dobMonth}>
              {days.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </Select>
          </HStack>
        </HStack>
        <FormErrorMessage ml="116px">
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
        <FormHelperText id="visit-type-help">不明点があれば受付にお知らせください</FormHelperText>
        <FormErrorMessage>選択してください</FormErrorMessage>
      </FormControl>
      <Flex justifyContent="center">
        <Button onClick={handleNext} colorScheme="primary" w="200px">
          問診を始める
        </Button>
      </Flex>
    </VStack>
  );
}
