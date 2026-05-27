import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  FormErrorMessage,
  SimpleGrid,
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
  type PersonalInfoKey,
  personalInfoFields,
  personalInfoMissingKeys,
} from '../utils/personalInfo';

const normalizeDobInput = (value: string) =>
  value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[^\d]/g, '')
    .trim();

const buildDob = (yearInput: string, monthInput: string, dayInput: string): string => {
  const normalizedYear = normalizeDobInput(yearInput);
  const normalizedMonth = normalizeDobInput(monthInput);
  const normalizedDay = normalizeDobInput(dayInput);
  if (normalizedYear.length !== 4 || !normalizedMonth || !normalizedDay) return '';

  const year = Number(normalizedYear);
  const month = Number(normalizedMonth);
  const day = Number(normalizedDay);
  if (!year || month < 1 || month > 12 || day < 1) return '';

  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return '';
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const trimDobPart = (value: string) => {
  const normalized = normalizeDobInput(value);
  const trimmed = normalized.replace(/^0+(\d)/, '$1');
  return trimmed || normalized;
};

const normalizePostalCode = (value: string) =>
  value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[^\d]/g, '')
    .slice(0, 7);

const formatPostalCode = (digits: string) =>
  digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;

/** 患者の基本情報を入力するページ。 */
export default function BasicInfo() {
  const navigate = useNavigate();
  const { notify } = useNotify();

  const [visitType, setVisitType] = useState(() => sessionStorage.getItem('visit_type') || '');
  const [name, setName] = useState(() => sessionStorage.getItem('patient_name') || '');
  const [gender, setGender] = useState(() => sessionStorage.getItem('gender') || '');
  const [dob, setDob] = useState(() => sessionStorage.getItem('dob') || '');
  const initialDob = sessionStorage.getItem('dob') || '';
  const [dobYearInput, setDobYearInput] = useState(() => (initialDob ? initialDob.slice(0, 4) : ''));
  const [dobMonthInput, setDobMonthInput] = useState(() =>
    initialDob ? trimDobPart(initialDob.slice(5, 7)) : ''
  );
  const [dobDayInput, setDobDayInput] = useState(() =>
    initialDob ? trimDobPart(initialDob.slice(8, 10)) : ''
  );
  const storedPersonal = (() => {
    try {
      const raw = sessionStorage.getItem('personal_info');
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  })();
  const [personalInfo, setPersonalInfo] = useState(() => createPersonalInfoValue(storedPersonal));
  const [lastAutoAddress, setLastAutoAddress] = useState('');
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!visitType) {
      navigate('/', { replace: true });
    }
  }, [visitType, navigate]);

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

  useEffect(() => {
    if (visitType !== 'initial') return;
    const digits = normalizePostalCode(personalInfo.postal_code);
    if (digits.length !== 7) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/postal-code/${digits}`, { signal: controller.signal });
        if (!response.ok) return;
        const data: { found?: boolean; address?: string | null } = await response.json();
        const address = typeof data.address === 'string' ? data.address.trim() : '';
        if (!data.found || !address) return;

        setPersonalInfo((prev) => {
          const currentAddress = prev.address.trim();
          if (currentAddress && currentAddress !== lastAutoAddress) {
            return prev;
          }
          const formattedPostalCode = formatPostalCode(digits);
          if (prev.postal_code === formattedPostalCode && prev.address === address) {
            return prev;
          }
          return {
            ...prev,
            postal_code: formattedPostalCode,
            address,
          };
        });
        setLastAutoAddress(address);
      } catch {
        // 郵便番号辞書が未更新または通信失敗でも、住所は手入力で継続できる。
      }
    }, 300);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [lastAutoAddress, personalInfo.postal_code, visitType]);

  const handlePersonalInfoChange = (key: PersonalInfoKey, value: string) => {
    setPersonalInfo((prev) => ({
      ...prev,
      [key]: key === 'postal_code' ? formatPostalCode(normalizePostalCode(value)) : value,
    }));
  };

  const handleBackToEntry = () => {
    sessionStorage.removeItem('patient_name');
    sessionStorage.removeItem('gender');
    sessionStorage.removeItem('dob');
    sessionStorage.removeItem('personal_info');
    setVisitType('');
    navigate('/', { replace: true });
  };

  type SessionCreateResponse = {
    id: string;
    questionnaire_id?: string;
    answers?: Record<string, any>;
  };

  const handleNext = async () => {
    setAttempted(true);
    const errs: string[] = [];
    const today = new Date().toISOString().slice(0, 10);

    if (!visitType) {
      errs.push('受診種別を選択してください');
    } else {
      const hasDobInput = [dobYearInput, dobMonthInput, dobDayInput].some((value) => value.trim());
      if (!name) errs.push('氏名を入力してください');
      if (!gender) errs.push('性別を選択してください');
      if (!hasDobInput) errs.push('生年月日を入力してください');
      if (hasDobInput && !dob) errs.push('生年月日を正しい日付で入力してください');
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
    let answersPayload: Record<string, any> = {};
    if (visitType === 'initial') {
      const infoToPersist = { ...personalInfo, name };
      answersPayload = { personal_info: infoToPersist };
      sessionStorage.setItem('personal_info', JSON.stringify(infoToPersist));
    } else {
      sessionStorage.removeItem('personal_info');
    }

    sessionStorage.removeItem('questionnaire_id');

    try {
      sessionStorage.setItem('visit_type', visitType);
      const payload = {
        patient_name: name,
        dob,
        gender,
        visit_type: visitType,
        answers: answersPayload,
      };
      const res = await fetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('failed');
      const data: SessionCreateResponse = await res.json();
      sessionStorage.setItem('session_id', data.id);
      sessionStorage.setItem('answers', JSON.stringify(data.answers ?? {}));
      const questionnaireId = data.questionnaire_id || 'default';
      sessionStorage.setItem('questionnaire_id', questionnaireId);
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
      if (!normalizeDobInput(dobYearInput)) {
        document.getElementById('dob-year')?.focus();
        return;
      }
      if (!normalizeDobInput(dobMonthInput)) {
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
  }, [
    attempted,
    visitType,
    name,
    gender,
    dob,
    dobYearInput,
    dobMonthInput,
    dobDayInput,
    kanaField,
    personalMissingKeysSet,
  ]);

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

  const syncDob = (yearInput: string, monthInput: string, dayInput: string) => {
    const parsed = buildDob(yearInput, monthInput, dayInput);
    setDob(parsed);
    if (parsed) {
      sessionStorage.setItem('dob', parsed);
    } else {
      sessionStorage.removeItem('dob');
    }
  };

  const handleDobYearChange = (value: string) => {
    const next = normalizeDobInput(value).slice(0, 4);
    setDobYearInput(next);
    syncDob(next, dobMonthInput, dobDayInput);
  };

  const handleDobMonthChange = (value: string) => {
    const next = normalizeDobInput(value).slice(0, 2);
    setDobMonthInput(next);
    syncDob(dobYearInput, next, dobDayInput);
  };

  const handleDobDayChange = (value: string) => {
    const next = normalizeDobInput(value).slice(0, 2);
    setDobDayInput(next);
    syncDob(dobYearInput, dobMonthInput, next);
  };

  const handleDobBlur = () => {
    const year = normalizeDobInput(dobYearInput).slice(0, 4);
    const month = trimDobPart(dobMonthInput).slice(0, 2);
    const day = trimDobPart(dobDayInput).slice(0, 2);
    setDobYearInput(year);
    setDobMonthInput(month);
    setDobDayInput(day);
    syncDob(year, month, day);
  };

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
      <HStack spacing={2} align="center" flexWrap="wrap">
        <Input
          id="dob-year"
          name="__noauto_dob_year"
          type="text"
          inputMode="numeric"
          placeholder="1990"
          value={dobYearInput}
          onChange={(e) => handleDobYearChange(e.target.value)}
          onInput={(e) => handleDobYearChange(e.currentTarget.value)}
          onBlur={handleDobBlur}
          autoComplete="bday-year"
          aria-label="生年月日 年"
          maxW="7rem"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <Text flexShrink={0}>年</Text>
        <Input
          id="dob-month"
          name="__noauto_dob_month"
          type="text"
          inputMode="numeric"
          placeholder="1"
          value={dobMonthInput}
          onChange={(e) => handleDobMonthChange(e.target.value)}
          onInput={(e) => handleDobMonthChange(e.currentTarget.value)}
          onBlur={handleDobBlur}
          autoComplete="bday-month"
          aria-label="生年月日 月"
          maxW="5rem"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <Text flexShrink={0}>月</Text>
        <Input
          id="dob-day"
          name="__noauto_dob_day"
          type="text"
          inputMode="numeric"
          placeholder="1"
          value={dobDayInput}
          onChange={(e) => handleDobDayChange(e.target.value)}
          onInput={(e) => handleDobDayChange(e.currentTarget.value)}
          onBlur={handleDobBlur}
          autoComplete="bday-day"
          aria-label="生年月日 日"
          maxW="5rem"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <Text flexShrink={0}>日</Text>
      </HStack>
      <FormErrorMessage>
        {dob && dob > new Date().toISOString().slice(0, 10)
          ? '生年月日に未来の日付は指定できません'
          : [dobYearInput, dobMonthInput, dobDayInput].some((value) => value.trim())
            ? '生年月日を正しい日付で入力してください'
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
                onChange={(e) => handlePersonalInfoChange(field.key, e.target.value)}
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
