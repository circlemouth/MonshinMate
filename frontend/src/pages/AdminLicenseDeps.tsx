import { useEffect, useState } from 'react';
import { Box, Spinner, Text } from '@chakra-ui/react';

/**
 * 管理画面: 依存ライブラリのライセンス一覧を表示するページ。
 */
export default function AdminLicenseDeps() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/docs/dependency_licenses.json')
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d) => setItems(d))
      .catch(() => setError('ライセンス情報の取得に失敗しました'));
  }, []);

  if (error) return <Text color="red.500" fontSize="sm">{error}</Text>;
  if (!items.length) return <Spinner />;

  return (
    <Box fontSize="sm">
      {items.map((item) => (
        <Box key={item.name} mb={6}>
          <Text fontWeight="bold">{item.name} {item.version} ({item.license})</Text>
          <Box as="pre" whiteSpace="pre-wrap" fontSize="xs" bg="gray.50" p={2}>
            {item.text}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
