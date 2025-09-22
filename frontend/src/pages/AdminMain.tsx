import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Button,
  VStack,
  SimpleGrid,
  HStack,
  Tag,
  useToast,
} from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { FiFile } from 'react-icons/fi';
import { LlmStatus } from '../utils/llmStatus';

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

type TemplateGroup = {
  id: string;
  visitTypes: string[];
};

const DB_STATUS_MAP: Record<DatabaseStatus, { label: string; color: string; description: string }> = {
  couchdb: { label: 'CouchDB', color: 'green', description: 'CouchDB コンテナに接続しています。' },
  sqlite: { label: 'SQLite', color: 'blue', description: 'ローカルの SQLite を使用しています。' },
  error: { label: '接続エラー', color: 'red', description: 'データベースの状態を取得できませんでした。' },
};

const LLM_STATUS_MAP: Record<LlmStatus, { label: string; color: string; description: string }> = {
  ok: { label: '疎通良好', color: 'green', description: 'LLM との接続は正常です。' },
  ng: { label: '接続エラー', color: 'red', description: 'LLM との接続に問題があります。' },
  disabled: { label: '無効', color: 'gray', description: 'LLM 機能は無効化されています。' },
};

const visitTypeLabel = (type: string) => (type === 'initial' ? '初診' : type === 'followup' ? '再診' : type);

const formatDateTime = (iso?: string | null) => {
  if (!iso) return '-';
  const [datePart, timePart] = iso.split('T');
  if (!timePart) return datePart;
  return `${datePart} ${timePart.slice(0, 5)}`;
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

  const toast = useToast();
  const navigate = useNavigate();

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
      const res = await fetch('/llm/settings');
      if (!res.ok) {
        throw new Error('failed to load llm settings');
      }
      const settings: LlmSettingsResponse = await res.json();
      setLlmSettings(settings);
      if (!settings.enabled) {
        setLlmStatus('disabled');
      } else {
        try {
          const testRes = await fetch('/llm/settings/test', { method: 'POST' });
          if (testRes.ok) {
            const result = await testRes.json();
            setLlmStatus(result?.status === 'ok' ? 'ok' : 'ng');
          } else {
            setLlmStatus('ng');
          }
        } catch (testErr) {
          console.error(testErr);
          setLlmStatus('ng');
        }
      }
    } catch (err) {
      console.error(err);
      setLlmSettings(null);
      setLlmStatus('ng');
      setLlmError('LLM 設定の取得に失敗しました。');
    } finally {
      setLlmLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadTemplates();
    void loadDatabaseStatus();
    void loadLlmInfo();
  }, [loadSessions, loadTemplates, loadDatabaseStatus, loadLlmInfo]);

  const templateGroups = useMemo<TemplateGroup[]>(() => {
    const map = new Map<string, Set<string>>();
    templates.forEach((tpl) => {
      if (!tpl?.id) return;
      const key = String(tpl.id);
      if (!map.has(key)) {
        map.set(key, new Set());
      }
      if (tpl.visit_type) {
        map.get(key)?.add(tpl.visit_type);
      }
    });
    return Array.from(map.entries())
      .map(([id, types]) => ({ id, visitTypes: Array.from(types).sort() }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [templates]);

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

  const llmStatusMeta = LLM_STATUS_MAP[llmStatus];
  const dbStatusMeta = DB_STATUS_MAP[dbStatus];

  const llmDetailText = (() => {
    if (llmError) return llmError;
    if (!llmSettings) return 'LLM 設定を取得できませんでした。';
    if (!llmSettings.enabled) return 'LLM 機能は無効化されています。';
    const provider = providerLabel(llmSettings.provider);
    const model = llmSettings.model && llmSettings.model.trim() ? llmSettings.model : '未設定';
    if (llmStatus === 'ok') {
      return `プロバイダ: ${provider} / モデル: ${model}`;
    }
    if (llmStatus === 'ng') {
      return `プロバイダ: ${provider} / モデル: ${model} - 疎通確認に失敗しました。`;
    }
    return `プロバイダ: ${provider} / モデル: ${model}`;
  })();

  return (
    <VStack align="stretch" spacing={10} py={6} px={{ base: 0, md: 2 }}>
      <Box>
        <Heading size="lg" mb={4}>
          再診問診（最新10件）
        </Heading>
        {sessionsLoading ? (
          <HStack spacing={3} align="center">
            <Spinner size="sm" />
            <Text fontSize="sm" color="gray.600">
              読み込み中...
            </Text>
          </HStack>
        ) : sessionError ? (
          <Text fontSize="sm" color="red.500">
            {sessionError}
          </Text>
        ) : sessions.length === 0 ? (
          <Text fontSize="sm" color="gray.600">
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
                <Tr
                  key={s.id}
                  _hover={{ bg: 'gray.50' }}
                  onClick={() => navigate(`/admin/sessions/${encodeURIComponent(s.id)}`)}
                  sx={{ cursor: 'pointer' }}
                >
                  <Td>{s.patient_name || '（未入力）'}</Td>
                  <Td>{formatDateTime(s.finalized_at)}</Td>
                  <Td onClick={(e) => e.stopPropagation()} whiteSpace="nowrap">
                    <Menu isLazy>
                      <MenuButton as={Button} size="sm" variant="outline" leftIcon={<FiFile />}>
                        出力
                      </MenuButton>
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
          <Text mt={3} fontSize="xs" color="gray.500">
            ※ 表示件数は再診データの最新10件です。詳細は「問診結果一覧」で確認できます。
          </Text>
        )}
      </Box>

      <Box>
        <Heading size="md" mb={4}>
          システムの状態
        </Heading>
        <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4}>
          <Box borderWidth="1px" borderRadius="md" p={4}>
            <Heading size="sm" mb={3}>
              使用中テンプレート
            </Heading>
            {templatesLoading ? (
              <HStack spacing={2}>
                <Spinner size="sm" />
                <Text fontSize="sm" color="gray.600">
                  読み込み中...
                </Text>
              </HStack>
            ) : templateError ? (
              <Text fontSize="sm" color="red.500">
                {templateError}
              </Text>
            ) : templateGroups.length === 0 ? (
              <Text fontSize="sm" color="gray.600">
                登録されているテンプレートがありません。
              </Text>
            ) : (
              <VStack align="stretch" spacing={2}>
                {defaultTemplateId && (
                  <Text fontSize="sm" color="gray.600">
                    既定テンプレートID: <strong>{defaultTemplateId}</strong>
                  </Text>
                )}
                {templateGroups.map((group) => (
                  <HStack key={group.id} spacing={3} align="center">
                    <Text fontWeight="semibold" fontSize="sm">
                      {group.id}
                    </Text>
                    {group.visitTypes.map((vt) => (
                      <Tag
                        key={vt}
                        size="sm"
                        colorScheme={vt === 'initial' ? 'blue' : vt === 'followup' ? 'purple' : 'gray'}
                      >
                        {visitTypeLabel(vt)}
                      </Tag>
                    ))}
                    {defaultTemplateId === group.id && (
                      <Tag size="sm" colorScheme="green">
                        既定
                      </Tag>
                    )}
                  </HStack>
                ))}
              </VStack>
            )}
          </Box>

          <Box borderWidth="1px" borderRadius="md" p={4}>
            <Heading size="sm" mb={3}>
              データベース
            </Heading>
            {dbLoading ? (
              <HStack spacing={2}>
                <Spinner size="sm" />
                <Text fontSize="sm" color="gray.600">
                  状態確認中...
                </Text>
              </HStack>
            ) : (
              <VStack align="stretch" spacing={2}>
                <Tag colorScheme={dbStatusMeta.color} variant="subtle" w="fit-content">
                  DB: {dbStatusMeta.label}
                </Tag>
                <Text fontSize="sm" color="gray.600">
                  {dbStatusMeta.description}
                </Text>
              </VStack>
            )}
          </Box>

          <Box borderWidth="1px" borderRadius="md" p={4}>
            <Heading size="sm" mb={3}>
              LLM
            </Heading>
            {llmLoading ? (
              <HStack spacing={2}>
                <Spinner size="sm" />
                <Text fontSize="sm" color="gray.600">
                  状態確認中...
                </Text>
              </HStack>
            ) : (
              <VStack align="stretch" spacing={2}>
                <Tag colorScheme={llmStatusMeta.color} variant="subtle" w="fit-content">
                  {llmStatusMeta.label}
                </Tag>
                <Text fontSize="sm" color="gray.600">
                  {llmDetailText}
                </Text>
                {llmSettings?.base_url && llmSettings.enabled && (
                  <Text fontSize="xs" color="gray.500">
                    接続先: {llmSettings.base_url}
                  </Text>
                )}
              </VStack>
            )}
          </Box>
        </SimpleGrid>
      </Box>
    </VStack>
  );
}

