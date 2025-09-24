import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  FormErrorMessage,
  SimpleGrid,
  Select,
  RadioGroup,
  Radio,
  HStack,
  Flex,
  Text,
} from '@chakra-ui/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { track } from '../metrics';
import { useNotify } from '../contexts/NotificationContext';
import {
  createPersonalInfoValue,
  personalInfoFields,
  personalInfoMissingKeys,
} from '../utils/personalInfo';

/** 患者の基本情報を入力するページ。 */
export default function BasicInfo() {
  const navigate = useNavigate();
  const { notify } = useNotify();

  const [visitType, setVisitType] = useState(() => sessionStorage.getItem('visit_type') || '');
  const [name, setName] = useState(() => sessionStorage.getItem('patient_name') || '');
  const [gender, setGender] = useState(() => sessionStorage.getItem('gender') || '');
  const [dob, setDob] = useState(() => sessionStorage.getItem('dob') || '');
  const initialDob = sessionStorage.getItem('dob') || '';
  const [dobYear, setDobYear] = useState<number | ''>(() => (initialDob ? Number(initialDob.slice(0, 4)) : ''));
  const [dobMonth, setDobMonth] = useState<number | ''>(() => (initialDob ? Number(initialDob.slice(5, 7)) : ''));
  const [dobDay, setDobDay] = useState<number | ''>(() => (initialDob ? Number(initialDob.slice(8, 10)) : ''));
  const storedPersonal = (() => {
    try {
      const raw = sessionStorage.getItem('personal_info');
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  })();
  const [personalInfo, setPersonalInfo] = useState(() => createPersonalInfoValue(storedPersonal));
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!visitType) {
      navigate('/', { replace: true });
    }
  }, [visitType, navigate]);

  const thisYear = new Date().getFullYear();
  const years = useMemo(() => Array.from({ length: 120 }, (_, i) => thisYear - i), [thisYear]);
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => i + 1), []);
  const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
  const maxDay =
    typeof dobYear === 'number' && typeof dobMonth === 'number'
      ? daysInMonth(dobYear, dobMonth)
      : 31;
  const days = useMemo(() => Array.from({ length: maxDay }, (_, i) => i + 1), [maxDay]);

  useEffect(() => {
    if (!visitType) return;
    if (dobYear && dobMonth && dobDay) {
      const mm = String(dobMonth).padStart(2, '0');
      const dd = String(Math.min(dobDay, daysInMonth(dobYear, dobMonth))).padStart(2, '0');
      const iso = `${dobYear}-${mm}-${dd}`;
      setDob(iso);
      sessionStorage.setItem('dob', iso);
    } else {
      setDob('');
      sessionStorage.removeItem('dob');
    }
  }, [dobYear, dobMonth, dobDay, visitType]);

  useEffect(() => {
    if (visitType) {
      sessionStorage.setItem('visit_type', visitType);
    } else {
      sessionStorage.removeItem('visit_type');
    }
  }, [visitType]);

  const kanaField = personalInfoFields.find((field) => field.key === 'kana');
  const additionalPersonalFields = personalInfoFields.filter((field) =>
    !['name', 'kana'].includes(field.key)
  );

  const personalMissingKeysSet = useMemo(() => {
    if (visitType !== 'initial') return new Set<string>();
    const missing = personalInfoMissingKeys({ ...personalInfo, name }).filter((key) => key !== 'name');
    return new Set<string>(missing);
  }, [personalInfo, visitType, name]);

  const handleBackToEntry = () => {
    sessionStorage.removeItem('patient_name');
    sessionStorage.removeItem('gender');
    sessionStorage.removeItem('dob');
    sessionStorage.removeItem('personal_info');
    setVisitType('');
    navigate('/', { replace: true });
  };

  const handleNext = async () => {
    setAttempted(true);
    const errs: string[] = [];
    const today = new Date().toISOString().slice(0, 10);

    if (!visitType) {
      errs.push('受診種別を選択してください');
    } else {
      if (!name) errs.push('氏名を入力してください');
      if (!gender) errs.push('性別を選択してください');
      if (!dob) errs.push('生年月日を入力してください');
      if (dob && dob > today) errs.push('生年月日に未来の日付は指定できません');
      if (visitType === 'initial' && personalMissingKeysSet.size > 0) {
        errs.push('患者基本情報を入力してください');
      }
    }

    if (errs.length > 0) {
      track('validation_failed', { page: 'BasicInfo', count: errs.length });
      return;
    }

    sessionStorage.setItem('patient_name', name);
    sessionStorage.setItem('gender', gender);
    if (visitType === 'initial') {
      const infoToPersist = { ...personalInfo, name };
      sessionStorage.setItem('personal_info', JSON.stringify(infoToPersist));
    } else {
      sessionStorage.removeItem('personal_info');
    }

    try {
      sessionStorage.setItem('visit_type', visitType);
      const payload = { patient_name: name, dob, gender, visit_type: visitType, answers: {} };
      const res = await fetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      sessionStorage.setItem('session_id', data.id);
      navigate('/questionnaire');
    } catch (error) {
      notify({
        title: 'セッションの作成に失敗しました。',
        description: '時間をおいて再度お試しください。',
        status: 'error',
        channel: 'patient',
        actionLabel: '再試行',
        onAction: () => {
          void handleNext();
        },
      });
    }
  };

  useEffect(() => {
    if (!attempted) return;
    const today = new Date().toISOString().slice(0, 10);

    if (!visitType) {
      document.getElementById('basic-info-title')?.focus();
      return;
    }

    if (!name) {
      document.getElementById('patient_name')?.focus();
      return;
    }

    if (visitType === 'initial') {
      if (kanaField && personalMissingKeysSet.has('kana')) {
        document.getElementById('personal-kana')?.focus();
        return;
      }
    }

    if (!gender) {
      document.getElementsByName('gender')?.[0]?.focus();
      return;
    }

    if (!dob || (dob && dob > today)) {
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

    if (visitType === 'initial') {
      for (const key of ['postal_code', 'address', 'phone']) {
        if (personalMissingKeysSet.has(key)) {
          document.getElementById(`personal-${key}`)?.focus();
          return;
        }
      }
    }
  }, [attempted, visitType, name, gender, dob, dobYear, dobMonth, kanaField, personalMissingKeysSet]);

  const renderNameFields = (includeKana: boolean) => (
    <VStack align="stretch" spacing={includeKana ? 2 : 0}>
      <FormControl isRequired isInvalid={attempted && !!visitType && !name}>
        <FormLabel htmlFor="patient_name">氏名</FormLabel>
        <Input
          id="patient_name"
          name="__noauto_patient_name"
          placeholder="問診 太郎"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <FormErrorMessage>氏名を入力してください</FormErrorMessage>
      </FormControl>
      {includeKana && kanaField && (
        <FormControl isRequired isInvalid={attempted && personalMissingKeysSet.has('kana')}>
          <FormLabel htmlFor="personal-kana" fontSize="sm">
            {kanaField.label}
          </FormLabel>
          <Input
            id="personal-kana"
            value={personalInfo.kana}
            placeholder={kanaField.placeholder}
            autoComplete={kanaField.autoComplete}
            inputMode={kanaField.inputMode}
            onChange={(e) =>
              setPersonalInfo((prev) => ({
                ...prev,
                kana: e.target.value,
              }))
            }
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <FormErrorMessage>{kanaField.label}を入力してください</FormErrorMessage>
        </FormControl>
      )}
    </VStack>
  );

  const renderGenderField = () => (
    <FormControl isRequired isInvalid={attempted && !!visitType && !gender}>
      <FormLabel>性別</FormLabel>
      <RadioGroup value={gender} onChange={setGender}>
        <HStack spacing={4}>
          <Radio value="male" name="gender">
            男
          </Radio>
          <Radio value="female" name="gender">
            女
          </Radio>
        </HStack>
      </RadioGroup>
      <FormErrorMessage>性別を選択してください</FormErrorMessage>
    </FormControl>
  );

  const renderDobField = () => (
    <FormControl
      isRequired
      isInvalid={
        attempted &&
        !!visitType &&
        (!dob || (dob && dob > new Date().toISOString().slice(0, 10)))
      }
    >
      <FormLabel>生年月日</FormLabel>
      <HStack>
        <Select
          id="dob-year"
          placeholder="年"
          value={dobYear}
          onChange={(e) => setDobYear(e.target.value ? Number(e.target.value) : '')}
          autoComplete="off"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <Select
          id="dob-month"
          placeholder="月"
          value={dobMonth}
          onChange={(e) => setDobMonth(e.target.value ? Number(e.target.value) : '')}
          autoComplete="off"
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <Select
          id="dob-day"
          placeholder="日"
          value={dobDay}
          onChange={(e) => setDobDay(e.target.value ? Number(e.target.value) : '')}
          isDisabled={!dobYear || !dobMonth}
          autoComplete="off"
        >
          {days.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </HStack>
      <FormErrorMessage>
        {dob && dob > new Date().toISOString().slice(0, 10)
          ? '生年月日に未来の日付は指定できません'
          : '生年月日を入力してください'}
      </FormErrorMessage>
    </FormControl>
  );

  const renderInitialFields = () => (
    <VStack spacing={5} align="stretch">
      {renderNameFields(true)}
      {renderGenderField()}
      {renderDobField()}
      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
        {additionalPersonalFields.map((field) => {
          const fieldMissing = personalMissingKeysSet.has(field.key);
          return (
            <FormControl key={field.key} isRequired isInvalid={attempted && fieldMissing}>
              <FormLabel htmlFor={`personal-${field.key}`} fontSize="sm">
                {field.label}
              </FormLabel>
              <Input
                id={`personal-${field.key}`}
                value={personalInfo[field.key]}
                placeholder={field.placeholder}
                autoComplete={field.autoComplete}
                inputMode={field.inputMode}
                onChange={(e) =>
                  setPersonalInfo((prev) => ({
                    ...prev,
                    [field.key]: e.target.value,
                  }))
                }
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <FormErrorMessage>{field.label}を入力してください</FormErrorMessage>
            </FormControl>
          );
        })}
      </SimpleGrid>
    </VStack>
  );

  const renderFollowupFields = () => (
    <VStack spacing={4} align="stretch">
      {renderNameFields(false)}
      {renderGenderField()}
      {renderDobField()}
    </VStack>
  );

  const visitTypeLabel = visitType === 'initial' ? '初診の方' : visitType === 'followup' ? '再診の方' : '患者の方';

  return (
    <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
      <VStack spacing={6} align="stretch">
        <Text id="basic-info-title" as="h2" fontSize="2xl" fontWeight="bold" textAlign="center">
          {visitTypeLabel}の基本情報を入力してください
        </Text>

        {visitType === 'initial' && renderInitialFields()}
        {visitType === 'followup' && renderFollowupFields()}

        <Flex justifyContent="space-between" align="center" flexWrap="wrap" gap={4}>
          <Button variant="ghost" onClick={handleBackToEntry}>
            受診種別を選び直す
          </Button>
          <Button
            onClick={handleNext}
            colorScheme="primary"
            size="lg"
            w={{ base: '100%', sm: '280px' }}
            maxW="400px"
            py={6}
            fontSize="lg"
          >
            次へ
          </Button>
        </Flex>
      </VStack>
    </form>
  );
}
