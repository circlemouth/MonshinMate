import { useEffect, useState } from 'react';
import { Tag } from '@chakra-ui/react';

/**
 * 管理画面ヘッダー用の LLM 接続状態バッジ（小さめ）。
 */
export default function LlmStatusBadge() {
  const [status, setStatus] = useState<'ok' | 'ng' | 'disabled'>('disabled');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const s = await fetch('/llm/settings').then((r) => r.json());
        if (!s?.enabled) {
          if (!cancelled) setStatus('disabled');
          return;
        }
        const t = await fetch('/llm/settings/test', { method: 'POST' }).then((r) => r.json());
        if (!cancelled) setStatus(t?.status === 'ok' ? 'ok' : 'ng');
      } catch (e) {
        if (!cancelled) setStatus('ng');
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  const label = status === 'ok' ? 'LLM接続済' : status === 'ng' ? 'LLM接続エラー' : 'LLM無効';
  const scheme = status === 'ok' ? 'green' : status === 'ng' ? 'red' : 'gray';

  return (
    <Tag
      size="sm"
      colorScheme={scheme}
      variant="subtle"
      mr={2}
    >
      {label}
    </Tag>
  );
}
