import { useEffect, useState } from 'react';
import { Tag } from '@chakra-ui/react';

/**
 * CouchDB の稼働状況バッジ。
 * - 緑: 稼働中
 * - 赤: 停止または疎通不可
 * - 灰: 無効
 */
export default function CouchDbStatusBadge() {
  const [status, setStatus] = useState<'ok' | 'ng' | 'disabled'>('disabled');

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const r = await fetch('/system/couchdb-status');
        if (!mounted) return;
        if (r.ok) {
          const d = await r.json();
          setStatus(d?.status ?? 'ng');
        } else {
          setStatus('ng');
        }
      } catch {
        if (mounted) setStatus('ng');
      }
    };
    fetchStatus();
    return () => {
      mounted = false;
    };
  }, []);

  const label =
    status === 'ok'
      ? 'CouchDB接続済'
      : status === 'ng'
      ? 'CouchDBエラー'
      : 'CouchDB未使用';
  const scheme = status === 'ok' ? 'green' : status === 'ng' ? 'red' : 'gray';

  return (
    <Tag size="sm" colorScheme={scheme} variant="subtle" mr={2}>
      {label}
    </Tag>
  );
}
