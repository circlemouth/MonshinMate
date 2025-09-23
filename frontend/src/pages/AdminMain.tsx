import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Heading,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Spinner,
  Text,
  Menu,
  MenuButton,
  MenuList,
  MenuItem,
  IconButton,
  VStack,
  SimpleGrid,
  HStack,
  Tooltip,
  Skeleton,
  useToast,
} from '@chakra-ui/react';
import { FiCpu, FiDatabase, FiDownload, FiLayers } from 'react-icons/fi';
import { LlmStatus, refreshLlmStatus } from '../utils/llmStatus';
import SystemStatusCard from '../components/SystemStatusCard';
import { useTimezone } from '../contexts/TimezoneContext';

interface SessionSummary {
  id: string;
  patient_name: string;
  dob: string;
  visit_type: string;
  finalized_at?: string | null;
}

interface TemplateEntry {
  id: string;
  visit_type: string;
}

interface LlmSettingsResponse {
  provider?: string;
  model?: string;
  enabled?: boolean;
  base_url?: string | null;
}

type DatabaseStatus = 'couchdb' | 'sqlite' | 'error';

const DB_STATUS_MAP: Record<DatabaseStatus, { label: string; color: string; description: string }> = {
  couchdb: { label: 'CouchDB', color: 'green', description: 'CouchDB コンテナに接続しています。' },
  sqlite: { label: 'SQLite', color: 'primary', description: 'ローカルの SQLite を使用しています。' },
  error: { label: '接続エラー', color: 'red', description: 'データベースの状態を取得できませんでした。' },
};

const LLM_STATUS_MAP: Record<LlmStatus, { label: string; color: string; description: string }> = {
  ok: { label: '疎通良好', color: 'green', description: 'LLM との接続は正常です。' },
  ng: { label: '接続エラー', color: 'red', description: 'LLM との接続に問題があります。' },
  disabled: { label: '無効', color: 'primary', description: 'LLM 機能は無効化されています。' },
  pending: { label: '確認待ち', color: 'orange', description: '直近の疎通確認を待っています。' },
};

const formatLocalDateTime = (date: Date) => {
  const pad = (value: number) => value.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

const providerLabel = (provider?: string) => {
  switch (provider) {
    case 'ollama':
      return 'Ollama';
    case 'lm_studio':
      return 'LM Studio';
    case 'openai':
      return 'OpenAI 互換';
    default:
      return provider || '未設定';
  }
};

export default function AdminMain() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);

  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState<boolean>(true);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);

  const [dbStatus, setDbStatus] = useState<DatabaseStatus>('sqlite');
  const [dbLoading, setDbLoading] = useState<boolean>(true);

  const [llmStatus, setLlmStatus] = useState<LlmStatus>('disabled');
  const [llmLoading, setLlmLoading] = useState<boolean>(true);
  const [llmSettings, setLlmSettings] = useState<LlmSettingsResponse | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmStatusDetail, setLlmStatusDetail] = useState<string | null>(null);
  const [llmStatusSource, setLlmStatusSource] = useState<string | null>(null);
  const [llmCheckedAt, setLlmCheckedAt] = useState<Date | null>(null);

  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const toast = useToast();
  const { formatDateTime } = useTimezone();

  const parseCheckedAt = (value: string | null | undefined): Date | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const sourceLabel = (source: string | null): string | null => {
    if (!source) return null;
    const map: Record<string, string> = {
      admin_login: '管理者ログイン',
      admin_login_totp: '管理者ログイン(TOTP)',
      manual_test: '疎通テスト',
      settings_put: '設定保存時',
      settings_update: '設定同期',
      generate_followups: '追加質問生成',
      generate_question: '追質問生成',
      chat: 'チャット',
      summarize: 'サマリー生成',
      startup: '起動時',
    };
    return map[source] ?? source;
  };

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionError(null);
    try {
      const res = await fetch('/admin/sessions');
      if (!res.ok) {
        throw new Error('failed to load sessions');
      }
      const data: SessionSummary[] = await res.json();
      const followups = data
        .filter((s) => s.visit_type === 'followup')
        .sort((a, b) => {
          const av = a.finalized_at || '';
          const bv = b.finalized_at || '';
          if (av === bv) return 0;
          return av < bv ? 1 : -1;
        })
        .slice(0, 10);
      setSessions(followups);
    } catch (err) {
      console.error(err);
      setSessions([]);
      setSessionError('再診問診データの取得に失敗しました。');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplateError(null);
    try {
      const [tplRes, defaultRes] = await Promise.all([
        fetch('/questionnaires'),
        fetch('/system/default-questionnaire'),
      ]);
      if (!tplRes.ok) {
        throw new Error('failed to load templates');
      }
      const tplData: TemplateEntry[] = await tplRes.json();
      setTemplates(tplData || []);
      if (defaultRes.ok) {
        const def = await defaultRes.json();
        setDefaultTemplateId(def?.questionnaire_id ?? null);
      } else {
        setDefaultTemplateId(null);
      }
    } catch (err) {
      console.error(err);
      setTemplates([]);
      setTemplateError('テンプレート情報の取得に失敗しました。');
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadDatabaseStatus = useCallback(async () => {
    setDbLoading(true);
    try {
      const res = await fetch('/system/database-status');
      if (!res.ok) {
        throw new Error('failed to fetch db status');
      }
      const data = await res.json();
      setDbStatus((data?.status as DatabaseStatus) ?? 'error');
    } catch (err) {
      console.error(err);
      setDbStatus('error');
    } finally {
      setDbLoading(false);
    }
  }, []);

  const loadLlmInfo = useCallback(async () => {
    setLlmLoading(true);
    setLlmError(null);
    try {
      const [res, snapshot] = await Promise.all([
        fetch('/llm/settings'),
        refreshLlmStatus(),
      ]);
      if (!res.ok) {
        throw new Error('failed to load llm settings');
      }
      const settings: LlmSettingsResponse = await res.json();
      setLlmSettings(settings);
      const effectiveStatus = settings.enabled ? snapshot.status : 'disabled';
      setLlmStatus(effectiveStatus);
      setLlmStatusDetail(snapshot.detail ?? null);
      setLlmStatusSource(snapshot.source ?? null);
      setLlmCheckedAt(parseCheckedAt(snapshot.checkedAt));
    } catch (err) {
      console.error(err);
      setLlmSettings(null);
      setLlmStatus('ng');
      setLlmError('LLM 設定の取得に失敗しました。');
      setLlmStatusDetail(null);
      setLlmStatusSource(null);
      setLlmCheckedAt(null);
    } finally {
      setLlmLoading(false);
    }
  }, []);

  useEffect(() => {
    const handler = (e: any) => {
      const payload = e?.detail as
        | { status?: LlmStatus; detail?: string | null; source?: string | null; checkedAt?: string | null }
        | undefined;
      if (!payload?.status) return;
      setLlmStatus(payload.status);
      setLlmStatusDetail(payload.detail ?? null);
      setLlmStatusSource(payload.source ?? null);
      setLlmCheckedAt(parseCheckedAt(payload.checkedAt));
    };
    window.addEventListener('llmStatusUpdated' as any, handler);
    return () => {
      window.removeEventListener('llmStatusUpdated' as any, handler);
    };
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadTemplates();
    void loadDatabaseStatus();
    void loadLlmInfo();
  }, [loadSessions, loadTemplates, loadDatabaseStatus, loadLlmInfo]);

  useEffect(() => {
    if (!templatesLoading && !dbLoading && !llmLoading) {
      setLastUpdatedAt(new Date());
    }
  }, [templatesLoading, dbLoading, llmLoading]);

  const templateSummaryValue = defaultTemplateId ?? '未設定';
  const templateTone = templateError
    ? 'error'
    : defaultTemplateId && templates.length > 0
    ? 'success'
    : 'warning';
  const templateSummaryDescription: string | undefined = templateError ?? undefined;

  const copyMarkdownForSession = async (id: string) => {
    try {
      setCopyingId(id);
      const res = await fetch(`/admin/sessions/${encodeURIComponent(id)}/download/md`);
      if (!res.ok) {
        throw new Error('failed to fetch markdown');
      }
      const text = await res.text();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      toast({
        title: 'Markdownをコピーしました',
        status: 'success',
        duration: 3000,
        isClosable: true,
        position: 'top-right',
      });
    } catch (err) {
      console.error(err);
      toast({
        title: 'Markdownのコピーに失敗しました',
        status: 'error',
        duration: 4000,
        isClosable: true,
        position: 'top-right',
      });
    } finally {
      setCopyingId(null);
    }
  };

  const dbStatusMeta = DB_STATUS_MAP[dbStatus];
  const llmStatusMeta = LLM_STATUS_MAP[llmStatus];

  const dbTone = dbStatus === 'error' ? 'error' : 'success';
  const dbSummaryValue = dbStatusMeta.label;
  const dbSummaryDescription = dbStatusMeta.description;

  const providerName = llmSettings ? providerLabel(llmSettings.provider) : '未設定';
  const modelName = llmSettings?.model && llmSettings.model.trim() ? llmSettings.model : '未設定';

  const llmTone = llmStatus === 'ok' ? 'success' : llmStatus === 'ng' ? 'error' : 'warning';
  const llmSummaryDescription = (() => {
    if (llmError) return llmError;
    if (!llmSettings) return 'LLM 設定を取得できませんでした。';
    if (!llmSettings.enabled) return 'LLM 機能は無効化されています。';
    const parts = [`プロバイダ: ${providerName} / モデル: ${modelName}`];
    if (llmStatusDetail) parts.push(`直近の結果: ${llmStatusDetail}`);
    const srcLabel = sourceLabel(llmStatusSource);
    if (srcLabel) parts.push(`更新契機: ${srcLabel}`);
    parts.push(`最終更新: ${llmCheckedAt ? formatLocalDateTime(llmCheckedAt) : '未実行'}`);
    return parts.join(' / ');
  })();

  return (
    <VStack align="stretch" spacing={10} py={6} px={{ base: 0, md: 2 }}>
      <Box>
        <Heading size="lg" mb={4}>
          再診問診（最新10件）
        </Heading>
        {sessionsLoading ? (
          <HStack spacing={3} align="center">
            <Spinner size="sm" color="accent.solid" />
            <Text fontSize="sm" color="fg.muted">
              読み込み中...
            </Text>
          </HStack>
        ) : sessionError ? (
          <Text fontSize="sm" color="red.500">
            {sessionError}
          </Text>
        ) : sessions.length === 0 ? (
          <Text fontSize="sm" color="fg.muted">
            再診の問診データがまだありません。
          </Text>
        ) : (
          <Table variant="simple">
            <Thead>
              <Tr>
                <Th>患者名</Th>
                <Th>問診日時</Th>
                <Th width="1%">出力</Th>
              </Tr>
            </Thead>
            <Tbody>
              {sessions.map((s) => (
                <Tr key={s.id}>
                  <Td>{s.patient_name || '（未入力）'}</Td>
                  <Td>{formatDateTime(s.finalized_at)}</Td>
                  <Td onClick={(e) => e.stopPropagation()} whiteSpace="nowrap">
                    <Menu isLazy>
                      <Tooltip label="出力" placement="bottom" hasArrow openDelay={150}>
                        <MenuButton
                          as={IconButton}
                          size="md"
                          variant="outline"
                          icon={<FiDownload />}
                          aria-label="問診結果を出力"
                          minW="44px"
                          minH="44px"
                        />
                      </Tooltip>
                      <MenuList>
                        <MenuItem
                          onClick={() =>
                            window.open(
                              `/admin/sessions/${encodeURIComponent(s.id)}/download/pdf`,
                              '_blank',
                              'noopener,noreferrer'
                            )
                          }
                        >
                          PDF
                        </MenuItem>
                        <MenuItem
                          onClick={() => copyMarkdownForSession(s.id)}
                          isDisabled={copyingId !== null && copyingId !== s.id}
                        >
                          {copyingId === s.id ? 'Markdownコピー中…' : 'Markdown'}
                        </MenuItem>
                        <MenuItem
                          onClick={() =>
                            window.open(
                              `/admin/sessions/${encodeURIComponent(s.id)}/download/csv`,
                              '_blank',
                              'noopener,noreferrer'
                            )
                          }
                        >
                          CSV
                        </MenuItem>
                      </MenuList>
                    </Menu>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
        {!sessionsLoading && sessions.length > 0 && (
          <Text mt={3} fontSize="xs" color="fg.muted">
            ※ 表示件数は再診データの最新10件です。詳細は「問診結果一覧」で確認できます。
          </Text>
        )}
      </Box>
      <Box>
        <Heading size="md" mb={4}>
          システム情報
        </Heading>
        <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4}>
          <Skeleton isLoaded={!templatesLoading} borderRadius="lg" fadeDuration={0.2}>
            <SystemStatusCard
              icon={FiLayers}
              label="テンプレート"
              value={templateSummaryValue}
              tone={templateTone}
              description={templateSummaryDescription}
              footer={templateError || !defaultTemplateId ? undefined : `既定テンプレート: ${defaultTemplateId}`}
            />
          </Skeleton>
          <Skeleton isLoaded={!dbLoading} borderRadius="lg" fadeDuration={0.2}>
            <SystemStatusCard
              icon={FiDatabase}
              label="データベース"
              value={dbSummaryValue}
              tone={dbTone}
              description={dbSummaryDescription}
            />
          </Skeleton>
          <Skeleton isLoaded={!llmLoading} borderRadius="lg" fadeDuration={0.2}>
            <SystemStatusCard
              icon={FiCpu}
              label="LLM"
              value={llmStatusMeta.label}
              tone={llmTone}
              description={llmSummaryDescription}
            />
          </Skeleton>
        </SimpleGrid>
        {lastUpdatedAt && (
          <Text fontSize="xs" color="fg.muted" textAlign="right" mt={2}>
            最終更新: {formatLocalDateTime(lastUpdatedAt)}
          </Text>
        )}
      </Box>
    </VStack>
  );
}
