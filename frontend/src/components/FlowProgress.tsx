import { Box, Progress } from '@chakra-ui/react';
import { useLocation } from 'react-router-dom';

// 患者フロー用の進行インジケータ（簡易版）
// 管理画面やチャット等では非表示
export default function FlowProgress() {
  const { pathname } = useLocation();

  const isAdmin = pathname.startsWith('/admin');
  const isChat = pathname.startsWith('/chat');
  if (isAdmin || isChat) return null;

  const percent = (() => {
    switch (pathname) {
      case '/':
        return 16;
      case '/visit-type':
        return 32;
      case '/questionnaire':
        return 56;
      case '/llm-wait':
        return 64;
      case '/questions':
        return 88;
      case '/done':
        return 100;
      default:
        return 0;
    }
  })();

  if (percent === 0) return null;

  return (
    <Box mb={4}>
      <Progress value={percent} size="sm" colorScheme="primary" borderRadius="8px" />
    </Box>
  );
}

