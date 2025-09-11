import { useEffect, useState } from 'react';
import { Tag } from '@chakra-ui/react';

/**
 * データベースの状態バッジ。
 * - 緑: CouchDB 使用中
 * - 青: SQLite 使用中
 * - 赤: 接続エラー
 */
export default function DbStatusBadge() {
  const [status, setStatus] = useState<'couchdb' | 'sqlite' | 'error'>('sqlite');

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const r = await fetch('/system/database-status');
        if (!mounted) return;
        if (r.ok) {
          const d = await r.json();
          setStatus(d?.status ?? 'error');
        } else {
          setStatus('error');
        }
      } catch {
        if (mounted) setStatus('error');
      }
    };
    fetchStatus();
    return () => {
      mounted = false;
    };
  }, []);

  const label =
    status === 'couchdb'
      ? 'CouchDB使用中'
      : status === 'sqlite'
      ? 'SQLite使用中'
      : 'DB接続エラー';
  const scheme =
    status === 'couchdb' ? 'green' : status === 'sqlite' ? 'blue' : 'red';

  return (
    <Tag size="sm" colorScheme={scheme} variant="subtle" mr={2}>
      {label}
    </Tag>
  );
}
