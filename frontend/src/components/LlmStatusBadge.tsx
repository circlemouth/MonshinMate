import { useEffect, useState } from 'react';
import { Tag } from '@chakra-ui/react';
import { LlmStatus, refreshLlmStatus } from '../utils/llmStatus';

/**
 * 管理画面ヘッダー用の LLM 接続状態バッジ（小さめ）。
 */
export default function LlmStatusBadge() {
  const [status, setStatus] = useState<LlmStatus>('disabled');

  useEffect(() => {
    let mounted = true;
    const onUpdated = (e: any) => {
      if (!mounted) return;
      const st = (e?.detail as LlmStatus) ?? 'ng';
      setStatus(st);
    };
    window.addEventListener('llmStatusUpdated' as any, onUpdated);
    // 初期表示時に最新化
    refreshLlmStatus();
    return () => {
      mounted = false;
      window.removeEventListener('llmStatusUpdated' as any, onUpdated);
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
