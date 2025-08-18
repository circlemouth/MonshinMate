import { useState } from 'react';
import { VStack, FormControl, FormLabel, Input, Button } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';

/** 患者名と生年月日を入力するエントリページ。 */
export default function Entry() {
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const navigate = useNavigate();

  const handleNext = () => {
    sessionStorage.setItem('patient_name', name);
    sessionStorage.setItem('dob', dob);
    navigate('/visit-type');
  };

  return (
    <VStack spacing={4} align="stretch">
      <FormControl isRequired>
        <FormLabel>氏名</FormLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </FormControl>
      <FormControl isRequired>
        <FormLabel>生年月日</FormLabel>
        <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
      </FormControl>
      <Button onClick={handleNext} colorScheme="teal" isDisabled={!name || !dob}>
        次へ
      </Button>
    </VStack>
  );
}
