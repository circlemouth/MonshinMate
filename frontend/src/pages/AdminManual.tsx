import { useEffect, useState } from 'react';
import { Box, Spinner, Text } from '@chakra-ui/react';

/**
 * README.md の内容を表示し、システム全体の使い方を説明するページ。
 */
export default function AdminManual() {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // ルートの README.md を取得して表示する
    fetch('/README.md')
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.text();
      })
      .then((text) => setContent(text))
      .catch(() => setError('README の取得に失敗しました'));
  }, []);

  if (error) {
    return (
      <Text color="red.500" fontSize="sm">
        {error}
      </Text>
    );
  }

  if (!content) {
    return <Spinner />;
  }

  return (
    <Box whiteSpace="pre-wrap" fontSize="sm">
      {content}
    </Box>
  );
}
