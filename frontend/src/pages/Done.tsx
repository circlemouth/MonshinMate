import { useEffect } from 'react';
import { VStack, Box, Button, HStack } from '@chakra-ui/react';
import { track } from '../metrics';
import { useNavigate } from 'react-router-dom';

/** 完了メッセージと要約を表示するページ。 */
export default function Done() {
  const navigate = useNavigate();
  const summary = sessionStorage.getItem('summary') || '';

  useEffect(() => {
    if (!summary) {
      navigate('/');
    }
  }, [summary, navigate]);

  return (
    <VStack spacing={4} align="stretch">
      <Box>ご回答ありがとうございました。</Box>
      <HStack className="print-hidden">
        <Button
          size="sm"
          onClick={() => {
            track('print', { page: 'Done' });
            window.print();
          }}
          colorScheme="primary"
          variant="outline"
        >
          印刷する
        </Button>
      </HStack>
      <Box whiteSpace="pre-wrap">{summary}</Box>
    </VStack>
  );
}
