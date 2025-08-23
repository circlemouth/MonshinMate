import { VStack, Box, Button, Center } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/** 完了メッセージのみを表示するページ（要約や印刷は非表示）。 */
export default function Done() {
  const [message, setMessage] = useState('ご回答ありがとうございました。');
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
  }, []);

  const backToTop = () => {
    try {
      // セッション関連の保存値を軽くクリア
      sessionStorage.removeItem('session_id');
      sessionStorage.removeItem('summary');
      sessionStorage.removeItem('visit_type');
    } catch {}
    navigate('/');
  };

  return (
    <VStack spacing={6} align="center">
      <Box>{message}</Box>
      <Center>
        <Button colorScheme="primary" onClick={backToTop}>
          最初の画面に戻る
        </Button>
      </Center>
    </VStack>
  );
}
