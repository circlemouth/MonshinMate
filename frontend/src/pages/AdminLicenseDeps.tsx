import { useEffect, useState } from 'react';
import { Box, Heading } from '@chakra-ui/react';
import LicenseDependencyList from '../components/license/LicenseDependencyList';
import { LicenseEntry } from '../types/license';
import { fetchDependencyLicenses } from '../utils/license';

/**
 * 管理画面: 依存ライブラリのライセンス一覧を表示するページ。
 */
export default function AdminLicenseDeps() {
  const [items, setItems] = useState<LicenseEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchDependencyLicenses()
      .then((data) => setItems(data))
      .catch(() => setError('ライセンス情報の取得に失敗しました'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Box>
      <Heading size="lg" mb={4}>
        依存ライブラリライセンス一覧
      </Heading>
      <LicenseDependencyList entries={items} isLoading={loading} error={error} />
    </Box>
  );
}
