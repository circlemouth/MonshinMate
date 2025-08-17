import { VStack, Button } from '@chakra-ui/react';
import { Link } from 'react-router-dom';

/** ホーム画面。主要画面へのリンクを提供する。 */
export default function Home() {
  return (
    <VStack spacing={4} align="stretch">
      <Button as={Link} to="/form" colorScheme="teal">
        問診フォーム
      </Button>
      <Button as={Link} to="/admin" colorScheme="purple">
        管理画面
      </Button>
      <Button as={Link} to="/chat" colorScheme="orange">
        LLM チャット
      </Button>
    </VStack>
  );
}
