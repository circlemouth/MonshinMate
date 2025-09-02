import { useEffect, useState } from 'react';
import { Icon } from '@chakra-ui/react';
import { CheckCircleIcon, WarningIcon, NotAllowedIcon } from '@chakra-ui/icons';

/**
 * CouchDB コンテナの稼働状況アイコン。
 * - 緑: 稼働中
 * - 赤: 停止または疎通不可
 * - 灰: 無効
 */
export default function CouchDbStatusIcon() {
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

  const icon =
    status === 'ok' ? CheckCircleIcon : status === 'disabled' ? NotAllowedIcon : WarningIcon;
  const color =
    status === 'ok' ? 'green.500' : status === 'disabled' ? 'gray.400' : 'red.500';

  return <Icon as={icon} w={5} h={5} color={color} mr={2} />;
}
