import { VStack, Box, Button, Center } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadSystemBootstrap } from '../systemBootstrap';
import { clearPatientSession } from '../utils/patientSession';

/** Completion displays no patient/session data, including after browser Back. */
export default function Done() {
  const [message, setMessage] = useState('ご回答ありがとうございました。');
  const navigate = useNavigate();
  useEffect(() => {
    void loadSystemBootstrap().then(settings => setMessage(settings.completion_message)).catch(() => {});
  }, []);
  return <VStack spacing={6} align="center">
    <Box>{message}</Box>
    <Center><Button colorScheme="primary" onClick={() => {
      clearPatientSession(); navigate('/', { replace: true });
    }}>最初の画面に戻る</Button></Center>
  </VStack>;
}
