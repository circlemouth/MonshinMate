import { useEffect, useState } from 'react';
import { Tag } from '@chakra-ui/react';
import { LlmStatus } from '../utils/llmStatus';

/**
 * 管理画面ヘッダー用の LLM 接続状態バッジ（小さめ）。
 */
export default function LlmStatusBadge() {
  const [status, setStatus] = useState<LlmStatus>('disabled');
  const [hasBaseUrl, setHasBaseUrl] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    // 設定値（特に base_url の有無）を取得して表示文言の補助に用いる
    const fetchSettings = async () => {
      try {
        const r = await fetch('/llm/settings');
        if (!mounted) return;
        if (r.ok) {
          const s = await r.json();
          setHasBaseUrl(!!s?.base_url);
        }
      } catch {
        /* noop */
      }
    };
    fetchSettings();
    const onUpdated = (e: any) => {
      if (!mounted) return;
      const st = (e?.detail as LlmStatus) ?? 'ng';
      setStatus(st);
      // ステータス更新イベント受信時にも base_url の有無を取り直す
      fetchSettings();
    };
    window.addEventListener('llmStatusUpdated' as any, onUpdated);
    // 疎通チェックは Entry 側で行い、ここではイベントのみ購読
    return () => {
      mounted = false;
      window.removeEventListener('llmStatusUpdated' as any, onUpdated);
    };
  }, []);

  // 表示文言の方針:
  // - status === 'ok' かつ base_url あり: 「LLM接続済」(リモート疎通OK)
  // - status === 'ok' かつ base_url なし: 「LLM有効(ローカル)」(スタブ/ローカル運用)
  // - status === 'ng': 「LLM接続エラー」
  // - その他: 「LLM無効」
  const label =
    status === 'ok'
      ? hasBaseUrl
        ? 'LLM接続済'
        : 'LLM有効(ローカル)'
      : status === 'ng'
      ? 'LLM接続エラー'
      : 'LLM未使用';
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
