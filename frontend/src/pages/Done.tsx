import { useEffect } from 'react';
import { VStack, Box } from '@chakra-ui/react';
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
      <Box whiteSpace="pre-wrap">{summary}</Box>
    </VStack>
  );
}
