import { useEffect, useState } from 'react';
import { VStack, FormControl, FormLabel, RadioGroup, HStack, Radio, Button, FormHelperText } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';

/** 初診/再診を選択しセッションを作成するページ。 */
export default function VisitType() {
  const [visitType, setVisitType] = useState('initial');
  const navigate = useNavigate();

  useEffect(() => {
    const name = sessionStorage.getItem('patient_name');
    const dob = sessionStorage.getItem('dob');
    if (!name || !dob) {
      navigate('/');
    }
  }, [navigate]);

  const handleNext = async () => {
    const patient_name = sessionStorage.getItem('patient_name') || '';
    const dob = sessionStorage.getItem('dob') || '';
    const payload = { patient_name, dob, visit_type: visitType, answers: {} };
    const res = await fetch('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    sessionStorage.setItem('session_id', data.id);
    sessionStorage.setItem('visit_type', visitType);
    navigate('/questionnaire');
  };

  return (
    <VStack spacing={4} align="stretch">
      <FormControl>
        <FormLabel>受診種別</FormLabel>
        <RadioGroup value={visitType} onChange={setVisitType} aria-describedby="visit-type-help">
          <HStack spacing={4}>
            <Radio value="initial">初診</Radio>
            <Radio value="followup">再診</Radio>
          </HStack>
        </RadioGroup>
        <FormHelperText id="visit-type-help">受付スタッフの案内に従って選択してください。</FormHelperText>
      </FormControl>
      <Button onClick={handleNext} colorScheme="primary">
        次へ
      </Button>
    </VStack>
  );
}
