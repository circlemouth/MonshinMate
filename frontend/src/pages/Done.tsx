import { VStack, Box, Button, Center, useDisclosure } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TopErrorModal from '../components/TopErrorModal';

/** 完了メッセージのみを表示するページ（要約や印刷は非表示）。 */
export default function Done() {
  const [message, setMessage] = useState('ご回答ありがとうございました。');
  const [llmError, setLlmError] = useState('');
  const { isOpen, onOpen, onClose } = useDisclosure();
  const navigate = useNavigate();

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('/system/completion-message');
        if (r.ok) {
          const d = await r.json();
          if (d?.message) setMessage(d.message);
        }
      } catch {}
    };
    load();
    try {
      const err = sessionStorage.getItem('llm_error');
      if (err) {
        setLlmError(err);
        onOpen();
      }
    } catch {}
  }, [onOpen]);

  const backToTop = () => {
    try {
      // セッション関連の保存値を軽くクリア
      sessionStorage.removeItem('session_id');
      sessionStorage.removeItem('summary');
      sessionStorage.removeItem('visit_type');
      sessionStorage.removeItem('llm_error');
    } catch {}
    navigate('/');
  };

  const closeError = () => {
    onClose();
    try {
      sessionStorage.removeItem('llm_error');
    } catch {}
  };

  return (
    <VStack spacing={6} align="center">
      <TopErrorModal isOpen={isOpen} onClose={closeError} message={llmError} />
      <Box>{message}</Box>
      <Center>
        <Button colorScheme="primary" onClick={backToTop}>
          最初の画面に戻る
        </Button>
      </Center>
    </VStack>
  );
}
