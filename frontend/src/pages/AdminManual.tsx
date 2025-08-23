import { useEffect, useState } from 'react';
import { Box, Spinner, Text } from '@chakra-ui/react';

/**
 * 管理画面セットアップ手順書（docs/admin_system_setup.md）の内容を表示し、システム全体の使い方を説明するページ。
 */
export default function AdminManual() {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // 管理画面セットアップ手順書を取得して表示する
    fetch('/docs/admin_system_setup.md')
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.text();
      })
      .then((text) => setContent(text))
      .catch(() => setError('ドキュメントの取得に失敗しました'));
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
