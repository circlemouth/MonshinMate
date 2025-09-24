import { useCallback, useEffect, useState, ChangeEvent } from 'react';
import {
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Input,
  Select,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  VStack,
} from '@chakra-ui/react';
import { FiDownload, FiUpload } from 'react-icons/fi';
import AccentOutlineBox from '../components/AccentOutlineBox';
import { useTimezone } from '../contexts/TimezoneContext';
import { useNotify } from '../contexts/NotificationContext';

interface SessionSummary {
  id: string;
  patient_name: string;
  dob: string;
  visit_type: string;
  started_at?: string | null;
  finalized_at?: string | null;
  interrupted?: boolean;
}

export default function AdminDataTransfer() {
  const { notify } = useNotify();
  const { formatDateTime } = useTimezone();
  const PAGE_SIZE = 20;

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [patientName, setPatientName] = useState('');
  const [dob, setDob] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [partialExport, setPartialExport] = useState(false);
  const [sessionPage, setSessionPage] = useState(0);
  const [sessionLoading, setSessionLoading] = useState(false);

  const [sessionExportPassword, setSessionExportPassword] = useState('');
  const [sessionExporting, setSessionExporting] = useState(false);
  const [sessionImportFile, setSessionImportFile] = useState<File | null>(null);
  const [sessionImportPassword, setSessionImportPassword] = useState('');
  const [sessionImportMode, setSessionImportMode] = useState<'merge' | 'replace'>('merge');
  const [sessionImporting, setSessionImporting] = useState(false);

  const [templateExportPassword, setTemplateExportPassword] = useState('');
  const [templateExporting, setTemplateExporting] = useState(false);
  const [templateImportFile, setTemplateImportFile] = useState<File | null>(null);
  const [templateImportPassword, setTemplateImportPassword] = useState('');
  const [templateImportMode, setTemplateImportMode] = useState<'merge' | 'replace'>('merge');
  const [templateImporting, setTemplateImporting] = useState(false);

  const visitTypeLabel = (type: string) => {
    switch (type) {
      case 'initial':
        return '初診';
      case 'followup':
        return '再診';
      default:
        return type ?? '';
    }
  };

  const getTargetIds = () => {
    if (partialExport && selectedSessionIds.length > 0) {
      return selectedSessionIds;
    }
    return sessions.map((s) => s.id);
  };

  const totalPages = Math.max(Math.ceil(sessions.length / PAGE_SIZE), 1);
  const paginatedSessions = sessions.slice(sessionPage * PAGE_SIZE, sessionPage * PAGE_SIZE + PAGE_SIZE);
  const displayedSessionIds = paginatedSessions.map((s) => s.id);
  const allDisplayedSelected =
    displayedSessionIds.length > 0 && displayedSessionIds.every((id) => selectedSessionIds.includes(id));
  const someDisplayedSelected =
    displayedSessionIds.some((id) => selectedSessionIds.includes(id)) && !allDisplayedSelected;

  type SessionFilters = {
    patientName?: string;
    dob?: string;
    startDate?: string;
    endDate?: string;
  };

  const loadSessions = useCallback(async (filters: SessionFilters) => {
    setSessionLoading(true);
    const params = new URLSearchParams();
    const trimmedPatient = filters.patientName?.trim();
    const trimmedDob = filters.dob?.trim();
    const trimmedStart = filters.startDate?.trim();
    const trimmedEnd = filters.endDate?.trim();
    if (trimmedPatient) params.append('patient_name', trimmedPatient);
    if (trimmedDob) params.append('dob', trimmedDob);
    if (trimmedStart) params.append('start_date', trimmedStart);
    if (trimmedEnd) params.append('end_date', trimmedEnd);
    const qs = params.toString();

    try {
      const res = await fetch(`/admin/sessions${qs ? `?${qs}` : ''}`);
      if (!res.ok) {
        const raw = await res.text();
        let message = '問診データの取得に失敗しました';
        try {
          const parsed = raw ? JSON.parse(raw) : null;
          if (parsed?.detail) {
            message = parsed.detail;
          } else if (raw) {
            message = raw;
          }
        } catch {
          if (raw) message = raw;
        }
        throw new Error(message);
      }

      const data: unknown = await res.json();
      if (!Array.isArray(data)) {
        throw new Error('サーバーから想定外のデータ形式が返されました');
      }

      setSessions(data as SessionSummary[]);
      setSelectedSessionIds([]);
      setSessionPage(0);
    } catch (err) {
      console.error(err);
      notify({
        title: err instanceof Error ? err.message : '問診データの取得に失敗しました',
        status: 'error',
        channel: 'admin',
        duration: 4000,
      });
    } finally {
      setSessionLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadSessions({});
  }, [loadSessions]);

  useEffect(() => {
    if (!partialExport) {
      if (selectedSessionIds.length > 0) {
        setSelectedSessionIds([]);
      }
      if (sessionPage !== 0) {
        setSessionPage(0);
      }
    }
  }, [partialExport, selectedSessionIds.length, sessionPage]);

  useEffect(() => {
    setSessionPage((prev) => {
      const maxIndex = Math.max(Math.ceil(sessions.length / PAGE_SIZE) - 1, 0);
      return Math.min(prev, maxIndex);
    });
  }, [sessions.length]);

  const handleSearch = () => {
    void loadSessions({ patientName, dob, startDate, endDate });
  };

  const handleReset = () => {
    setPatientName('');
    setDob('');
    setStartDate('');
    setEndDate('');
    void loadSessions({});
  };

  const handleSessionExport = async () => {
    try {
      const targetIds = getTargetIds();
      if (targetIds.length === 0 && !startDate && !endDate) {
        notify({ title: '出力対象の問診がありません', status: 'warning', channel: 'admin', duration: 3000 });
        return;
      }
      setSessionExporting(true);
      const payload: Record<string, unknown> = { password: sessionExportPassword || null };
      if (targetIds.length > 0) payload.session_ids = targetIds;
      if (startDate) payload.start_date = startDate;
      if (endDate) payload.end_date = endDate;
      const res = await fetch('/admin/sessions/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'failed to export');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const filename = match ? decodeURIComponent(match[1]) : `sessions-${Date.now()}.json`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      notify({ title: '問診データを出力しました', status: 'success', channel: 'admin', duration: 3000 });
    } catch (err) {
      console.error(err);
      notify({ title: '問診データの出力に失敗しました', status: 'error', channel: 'admin', duration: 4000 });
    } finally {
      setSessionExporting(false);
    }
  };

  const handleSessionImportFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSessionImportFile(file);
  };

  const handleSessionImport = async () => {
    if (!sessionImportFile) {
      notify({ title: 'インポートするファイルを選択してください', status: 'warning', channel: 'admin', duration: 3000 });
      return;
    }
    const formData = new FormData();
    formData.append('file', sessionImportFile);
    formData.append('mode', sessionImportMode);
    if (sessionImportPassword) formData.append('password', sessionImportPassword);
    try {
      setSessionImporting(true);
      const res = await fetch('/admin/sessions/import', { method: 'POST', body: formData });
      if (!res.ok) {
        let message = '問診データのインポートに失敗しました';
        try {
          const data = await res.json();
          if (data?.detail) message = data.detail;
        } catch {
          const text = await res.text();
          if (text) message = text;
        }
        throw new Error(message);
      }
      loadSessions({ patientName, dob, startDate, endDate });
      setSessionImportFile(null);
      notify({ title: '問診データを取り込みました', status: 'success', channel: 'admin', duration: 3000 });
    } catch (err) {
      console.error(err);
      notify({
        title: err instanceof Error ? err.message : '問診データのインポートに失敗しました',
        status: 'error',
        channel: 'admin',
        duration: 5000,
      });
    } finally {
      setSessionImporting(false);
    }
  };

  const handleTemplateImportFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setTemplateImportFile(file);
  };

  const handleTemplateExport = async () => {
    try {
      setTemplateExporting(true);
      const res = await fetch('/admin/questionnaires/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: templateExportPassword || null }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'failed to export');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const filename = match ? decodeURIComponent(match[1]) : `questionnaire-settings-${Date.now()}.json`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      notify({ title: '設定ファイルを出力しました', status: 'success', channel: 'admin', duration: 3000 });
    } catch (err) {
      console.error(err);
      notify({ title: '設定ファイルの出力に失敗しました', status: 'error', channel: 'admin', duration: 4000 });
    } finally {
      setTemplateExporting(false);
    }
  };

  const handleTemplateImport = async () => {
    if (!templateImportFile) {
      notify({ title: 'インポートするファイルを選択してください', status: 'warning', channel: 'admin', duration: 3000 });
      return;
    }
    const formData = new FormData();
    formData.append('file', templateImportFile);
    formData.append('mode', templateImportMode);
    if (templateImportPassword) formData.append('password', templateImportPassword);
    try {
      setTemplateImporting(true);
      const res = await fetch('/admin/questionnaires/import', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        let message = '設定ファイルのインポートに失敗しました';
        try {
          const data = await res.json();
          if (data?.detail) message = data.detail;
        } catch {
          const text = await res.text();
          if (text) message = text;
        }
        throw new Error(message);
      }
      setTemplateImportFile(null);
      notify({ title: '設定ファイルを取り込みました', status: 'success', channel: 'admin', duration: 3000 });
    } catch (err) {
      console.error(err);
      notify({
        title: err instanceof Error ? err.message : '設定ファイルのインポートに失敗しました',
        status: 'error',
        channel: 'admin',
        duration: 5000,
      });
    } finally {
      setTemplateImporting(false);
    }
  };

  return (
    <VStack align="stretch" spacing={6}>
      <Box>
        <Heading size="lg" mb={2}>バックアップ</Heading>
        <Text fontSize="sm" color="fg.muted">
          問診データやテンプレート設定のバックアップ・移行を行うことができます。対象を選択し、必要に応じて暗号化パスワードを指定してください。
        </Text>
      </Box>

      <Card variant="outline" borderColor="border.accent" bg="bg.surface" boxShadow="sm" borderRadius="lg">
        <CardHeader pb={2}>
          <Heading size="md">問診データのエクスポート/インポート</Heading>
          <Text fontSize="sm" color="fg.muted">
            下部の出力は選択済みの問診、もしくは検索条件に一致する全件が対象です。選択がない場合は現在の一覧全てが含まれます。
          </Text>
        </CardHeader>
        <CardBody pt={0}>
          <VStack align="stretch" spacing={5}>
            <AccentOutlineBox p={4} borderRadius="lg">
              <Heading size="sm" mb={2}>対象の検索と選択</Heading>
              <VStack align="stretch" spacing={3}>
                <HStack spacing={4} align="flex-end" wrap="wrap">
                  <FormControl maxW="220px">
                    <FormLabel fontSize="sm">患者名</FormLabel>
                    <Input
                      value={patientName}
                      onChange={(e) => setPatientName(e.target.value)}
                      bg="bg.surface"
                      _hover={{ bg: 'bg.surface' }}
                      _focusVisible={{ bg: 'bg.surface' }}
                    />
                  </FormControl>
                  <FormControl maxW="200px">
                    <FormLabel fontSize="sm">生年月日</FormLabel>
                    <Input
                      type="date"
                      value={dob}
                      onChange={(e) => setDob(e.target.value)}
                      bg="bg.surface"
                      _hover={{ bg: 'bg.surface' }}
                      _focusVisible={{ bg: 'bg.surface' }}
                    />
                  </FormControl>
                  <FormControl maxW="200px">
                    <FormLabel fontSize="sm">問診日(開始)</FormLabel>
                    <Input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      bg="bg.surface"
                      _hover={{ bg: 'bg.surface' }}
                      _focusVisible={{ bg: 'bg.surface' }}
                    />
                  </FormControl>
                  <FormControl maxW="200px">
                    <FormLabel fontSize="sm">問診日(終了)</FormLabel>
                    <Input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      bg="bg.surface"
                      _hover={{ bg: 'bg.surface' }}
                      _focusVisible={{ bg: 'bg.surface' }}
                    />
                  </FormControl>
                  <HStack spacing={2} alignSelf="flex-end">
                    <Button
                      onClick={handleSearch}
                      size="sm"
                      colorScheme="primary"
                      isLoading={sessionLoading}
                      loadingText="検索中"
                    >
                      検索
                    </Button>
                    <Button
                      onClick={handleReset}
                      size="sm"
                      variant="ghost"
                      isDisabled={sessionLoading}
                    >
                      リセット
                    </Button>
                  </HStack>
                </HStack>
                <Checkbox
                  isChecked={partialExport}
                  onChange={(e) => setPartialExport((e.target as HTMLInputElement).checked)}
                  alignSelf="flex-start"
                >
                  一部のデータのみ出力
                </Checkbox>
                {!partialExport && (
                  <Text fontSize="xs" color="fg.muted">
                    チェックを入れると、問診データの一覧が表示され対象を選択できます。
                  </Text>
                )}
                {partialExport && (
                  <>
                    <AccentOutlineBox p={3} borderRadius="lg">
                      <Table size="sm" variant="simple">
                        <Thead>
                          <Tr>
                            <Th width="1%">
                              <Checkbox
                                isChecked={allDisplayedSelected}
                                isIndeterminate={someDisplayedSelected}
                                onChange={(e) => {
                                  const checked = (e.target as HTMLInputElement).checked;
                                  const displayedSet = new Set(displayedSessionIds);
                                  setSelectedSessionIds((prev) => {
                                    if (checked) {
                                      return Array.from(new Set([...prev, ...displayedSessionIds]));
                                    }
                                    return prev.filter((id) => !displayedSet.has(id));
                                  });
                                }}
                              />
                            </Th>
                            <Th>患者名</Th>
                            <Th>生年月日</Th>
                            <Th>受診種別</Th>
                            <Th>確定日時</Th>
                          </Tr>
                        </Thead>
                        <Tbody>
                          {paginatedSessions.map((s) => {
                            const selected = selectedSessionIds.includes(s.id);
                            return (
                              <Tr
                                key={s.id}
                                bg={selected ? 'bg.subtle' : undefined}
                                borderLeftWidth={selected ? '3px' : undefined}
                                borderLeftColor={selected ? 'accent.solid' : undefined}
                              >
                                <Td>
                                  <Checkbox
                                    isChecked={selected}
                                    onChange={(e) => {
                                      const checked = (e.target as HTMLInputElement).checked;
                                      setSelectedSessionIds((prev) => (
                                        checked
                                          ? Array.from(new Set([...prev, s.id]))
                                          : prev.filter((x) => x !== s.id)
                                      ));
                                    }}
                                  />
                                </Td>
                                <Td>{s.patient_name}</Td>
                                <Td>{s.dob}</Td>
                                <Td>{visitTypeLabel(s.visit_type)}</Td>
                                <Td>{formatDateTime(s.started_at ?? s.finalized_at)}</Td>
                              </Tr>
                            );
                          })}
                          {sessions.length === 0 && (
                            <Tr>
                              <Td colSpan={5}>
                                <Text fontSize="sm" color="fg.muted" textAlign="center">
                                  条件に一致する問診データがありません。
                                </Text>
                              </Td>
                            </Tr>
                          )}
                        </Tbody>
                      </Table>
                    </AccentOutlineBox>
                    <HStack justifyContent="space-between" align="center">
                      <Text fontSize="xs" color="fg.muted">
                        全体 {sessions.length} 件中 選択 {selectedSessionIds.length} 件
                      </Text>
                      <HStack spacing={3}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSessionPage((prev) => Math.max(prev - 1, 0))}
                          isDisabled={sessionPage === 0}
                        >
                          前のデータ
                        </Button>
                        <Text fontSize="xs" color="fg.muted">
                          ページ {sessionPage + 1} / {totalPages}
                        </Text>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSessionPage((prev) => Math.min(prev + 1, totalPages - 1))}
                          isDisabled={sessionPage >= totalPages - 1}
                        >
                          次のデータ
                        </Button>
                      </HStack>
                    </HStack>
                  </>
                )}
              </VStack>
            </AccentOutlineBox>

            <Divider />

            <Box>
              <Heading size="sm" mb={1}>問診データの出力</Heading>
              <Text fontSize="xs" color="fg.muted" mb={2}>
                選択がある場合はその問診のみ、未選択の場合は現在の一覧全件が対象です。必要に応じて暗号化パスワードを指定してください。
              </Text>
              <HStack spacing={3} align="flex-end" wrap="wrap">
                <FormControl maxW="260px">
                  <FormLabel fontSize="sm">エクスポート用パスワード（任意）</FormLabel>
                  <Input
                    type="password"
                    value={sessionExportPassword}
                    onChange={(e) => setSessionExportPassword(e.target.value)}
                    placeholder="未入力で平文出力"
                  />
                  <FormHelperText fontSize="xs">未入力の場合は暗号化せずに保存します。</FormHelperText>
                </FormControl>
                <Button
                  leftIcon={<FiDownload />}
                  onClick={handleSessionExport}
                  isLoading={sessionExporting}
                  variant="outline"
                >
                  JSON を出力
                </Button>
              </HStack>
            </Box>

            <Divider />

            <Box>
              <Heading size="sm" mb={1}>問診データのインポート</Heading>
              <Text fontSize="xs" color="fg.muted" mb={2}>
                既存データに追記するか、全件入れ替えるかを選択できます。入れ替えは元のデータが削除されるためご注意ください。
              </Text>
              <VStack align="stretch" spacing={3}>
                <FormControl>
                  <FormLabel fontSize="sm">インポートファイル</FormLabel>
                  <Input type="file" accept=".json" onChange={handleSessionImportFileChange} />
                </FormControl>
                <FormControl maxW="260px">
                  <FormLabel fontSize="sm">ファイルのパスワード（暗号化時）</FormLabel>
                  <Input
                    type="password"
                    value={sessionImportPassword}
                    onChange={(e) => setSessionImportPassword(e.target.value)}
                    placeholder="暗号化済みの場合のみ入力"
                  />
                </FormControl>
                <FormControl maxW="240px">
                  <FormLabel fontSize="sm">反映モード</FormLabel>
                  <Select
                    value={sessionImportMode}
                    onChange={(e) => setSessionImportMode(e.target.value as 'merge' | 'replace')}
                  >
                    <option value="merge">既存に上書き</option>
                    <option value="replace">既存を削除して入れ替え</option>
                  </Select>
                  <FormHelperText fontSize="xs">入れ替えを選ぶと保存済みの問診結果が全て削除されます。</FormHelperText>
                </FormControl>
                <Button
                  leftIcon={<FiUpload />}
                  onClick={handleSessionImport}
                  colorScheme="primary"
                  isLoading={sessionImporting}
                  isDisabled={!sessionImportFile}
                  alignSelf="flex-start"
                >
                  インポートを実行
                </Button>
              </VStack>
            </Box>
          </VStack>
        </CardBody>
      </Card>

      <Card variant="outline" borderColor="border.accent" bg="bg.surface" boxShadow="sm" borderRadius="lg">
        <CardHeader pb={2}>
          <Heading size="md">問診テンプレート設定のエクスポート/インポート</Heading>
          <Text fontSize="sm" color="fg.muted">
            テンプレート・プロンプト・画像などの設定一式をバックアップできます。
          </Text>
        </CardHeader>
        <CardBody pt={0}>
          <VStack align="stretch" spacing={4}>
            <Box>
              <Heading size="sm" mb={1}>設定ファイルの出力</Heading>
              <Text fontSize="xs" color="fg.muted" mb={2}>
                暗号化したい場合は任意のパスワードを指定してください。
              </Text>
              <HStack align="flex-end" spacing={3} wrap="wrap">
                <FormControl maxW="280px">
                  <FormLabel fontSize="sm">エクスポート用パスワード（任意）</FormLabel>
                  <Input
                    type="password"
                    value={templateExportPassword}
                    onChange={(e) => setTemplateExportPassword(e.target.value)}
                    placeholder="未入力で平文出力"
                  />
                  <FormHelperText fontSize="xs">未入力の場合は暗号化せずに保存します。</FormHelperText>
                </FormControl>
                <Button onClick={handleTemplateExport} isLoading={templateExporting} variant="outline">
                  ダウンロード
                </Button>
              </HStack>
            </Box>
            <Divider />
            <Box>
              <Heading size="sm" mb={1}>設定ファイルのインポート</Heading>
              <Text fontSize="xs" color="fg.muted" mb={2}>
                既存の設定に上書きするか、全て入れ替えるかを選択できます。
              </Text>
              <VStack align="stretch" spacing={3}>
                <FormControl>
                  <FormLabel fontSize="sm">インポートファイル</FormLabel>
                  <Input type="file" accept=".json" onChange={handleTemplateImportFileChange} />
                </FormControl>
                <FormControl maxW="260px">
                  <FormLabel fontSize="sm">ファイルのパスワード（暗号化時）</FormLabel>
                  <Input
                    type="password"
                    value={templateImportPassword}
                    onChange={(e) => setTemplateImportPassword(e.target.value)}
                    placeholder="暗号化済みの場合のみ入力"
                  />
                </FormControl>
                <FormControl maxW="240px">
                  <FormLabel fontSize="sm">反映モード</FormLabel>
                  <Select
                    value={templateImportMode}
                    onChange={(e) => setTemplateImportMode(e.target.value as 'merge' | 'replace')}
                  >
                    <option value="merge">既存に上書き</option>
                    <option value="replace">既存を削除して入れ替え</option>
                  </Select>
                  <FormHelperText fontSize="xs">入れ替えを選ぶと現在のテンプレートと画像が全て削除されます。</FormHelperText>
                </FormControl>
                <Button
                  leftIcon={<FiUpload />}
                  onClick={handleTemplateImport}
                  colorScheme="primary"
                  isLoading={templateImporting}
                  isDisabled={!templateImportFile}
                  alignSelf="flex-start"
                >
                  インポートを実行
                </Button>
              </VStack>
            </Box>
          </VStack>
        </CardBody>
      </Card>
    </VStack>
  );
}
