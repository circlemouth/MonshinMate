import { useEffect, useState } from 'react';
import { Tag } from '@chakra-ui/react';

const DATABASE_STATUSES = ['sqlite', 'couchdb', 'firestore', 'firestore_emulator', 'error'] as const;
type DatabaseStatus = (typeof DATABASE_STATUSES)[number];

const isDatabaseStatus = (value: string): value is DatabaseStatus =>
  DATABASE_STATUSES.includes(value as DatabaseStatus);

/**
 * データベースの状態バッジ。
 * - 緑: CouchDB 使用中
 * - 青: SQLite 使用中
 * - ティール: Firestore
 * - 紫: Firestore エミュレータ
 * - 赤: 接続エラー
 */
export default function DbStatusBadge() {
  const [status, setStatus] = useState<DatabaseStatus>('sqlite');

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const r = await fetch('/system/database-status');
        if (!mounted) return;
        if (r.ok) {
          const d = await r.json();
          const nextStatus = typeof d?.status === 'string' ? d.status : '';
          setStatus(isDatabaseStatus(nextStatus) ? nextStatus : 'error');
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

  const label = (() => {
    switch (status) {
      case 'couchdb':
        return 'DB:CouchDB';
      case 'sqlite':
        return 'DB:SQLite';
      case 'firestore':
        return 'DB:Firestore';
      case 'firestore_emulator':
        return 'DB:Firestore(Emu)';
      default:
        return 'DB:接続エラー';
    }
  })();

  const scheme = (() => {
    switch (status) {
      case 'couchdb':
        return 'green';
      case 'sqlite':
        return 'blue';
      case 'firestore':
        return 'teal';
      case 'firestore_emulator':
        return 'purple';
      default:
        return 'red';
    }
  })();

  return (
    <Tag size="sm" colorScheme={scheme} variant="subtle" mr={2}>
      {label}
    </Tag>
  );
}
