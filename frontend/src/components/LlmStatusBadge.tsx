import { useEffect, useMemo, useState } from 'react';
import { Tag } from '@chakra-ui/react';
import { LlmStatus, fetchLlmStatusSnapshot } from '../utils/llmStatus';

/**
 * 管理画面ヘッダー用の LLM 接続状態バッジ（小さめ）。
 */
export default function LlmStatusBadge() {
  const [status, setStatus] = useState<LlmStatus>('disabled');
  const [metaDetail, setMetaDetail] = useState<string | null>(null);
  const [metaSource, setMetaSource] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
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
    const applySnapshot = (snapshot: { status: LlmStatus; detail?: string | null; source?: string | null; checkedAt?: string | null }) => {
      setStatus(snapshot.status);
      setMetaDetail(snapshot.detail ?? null);
      setMetaSource(snapshot.source ?? null);
      setCheckedAt(snapshot.checkedAt ?? null);
    };
    fetchSettings();
    fetchLlmStatusSnapshot()
      .then((snapshot) => {
        if (!mounted) return;
        applySnapshot(snapshot);
      })
      .catch(() => {
        /* noop */
      });
    const onUpdated = (e: CustomEvent) => {
      if (!mounted) return;
      const detail = e?.detail as
        | { status: LlmStatus; detail?: string | null; source?: string | null; checkedAt?: string | null }
        | undefined;
      if (!detail) return;
      applySnapshot({
        status: detail.status,
        detail: detail.detail,
        source: detail.source,
        checkedAt: detail.checkedAt,
      });
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
  const label = useMemo(() => {
    if (status === 'ok') {
      return hasBaseUrl ? 'LLM接続済' : 'LLM有効(ローカル)';
    }
    if (status === 'ng') return 'LLM接続エラー';
    if (status === 'pending') return 'LLM確認待ち';
    return 'LLM未使用';
  }, [status, hasBaseUrl]);
  const scheme = status === 'ok' ? 'green' : status === 'ng' ? 'red' : status === 'pending' ? 'yellow' : 'gray';

  const tooltip = useMemo(() => {
    const parts: string[] = [];
    if (checkedAt) {
      try {
        const date = new Date(checkedAt);
        parts.push(`最終更新: ${date.toLocaleString()}`);
      } catch {
        parts.push(`最終更新: ${checkedAt}`);
      }
    }
    if (metaSource) parts.push(`更新契機: ${metaSource}`);
    if (metaDetail) parts.push(`詳細: ${metaDetail}`);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }, [checkedAt, metaSource, metaDetail]);

  return (
    <Tag
      size="sm"
      colorScheme={scheme}
      variant="subtle"
      mr={2}
      title={tooltip}
    >
      {label}
    </Tag>
  );
}
