import { useEffect, useRef, useState } from 'react';
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  useDisclosure,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  VStack,
  Heading,
  Text,
  Box,
  Spinner,
  FormControl,
  FormLabel,
  Input,
  Button,
  IconButton,
  HStack,
  Tooltip,
  Checkbox,
  Flex,
  Spacer,
  Menu,
  MenuButton,
  MenuList,
  MenuItem,
  Tag,
  AlertDialog,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogBody,
  AlertDialogFooter,
} from '@chakra-ui/react';
import { FiDownload, FiFile, FiFileText, FiTable, FiTrash } from 'react-icons/fi';
import AccentOutlineBox from '../components/AccentOutlineBox';
import { useTimezone } from '../contexts/TimezoneContext';
import { useNotify } from '../contexts/NotificationContext';

interface SessionSummary {
  id: string;
  patient_name: string;
  dob: string;
  visit_type: string;
  finalized_at?: string | null;
}

/** 管理画面: セッション一覧。 */
export default function AdminSessions() {
  const PAGE_SIZE = 50;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [copyingMarkdownTarget, setCopyingMarkdownTarget] = useState<string | null>(null);
  const preview = useDisclosure();
  const { notify } = useNotify();
  const { formatDateTime, formatDate } = useTimezone();

  const [patientName, setPatientName] = useState('');
  const [dob, setDob] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(0);
  const [confirmState, setConfirmState] = useState<{ type: 'bulk-selected' | 'bulk-displayed' | 'row'; id?: string } | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const loadSessions = (filters: {
    patientName?: string;
    dob?: string;
    startDate?: string;
    endDate?: string;
  }) => {
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
    fetch(`/admin/sessions${qs ? `?${qs}` : ''}`)
      .then((r) => r.json())
      .then((data: SessionSummary[]) => {
        // 並び替え: 問診日時（finalized_at）の新しい順
        const sorted = [...data].sort((a, b) => {
          const av = a.finalized_at || '';
          const bv = b.finalized_at || '';
          return av < bv ? 1 : av > bv ? -1 : 0;
        });
        setSessions(sorted);
        // 一覧が更新されたら選択状態をクリア
        setSelectedSessionIds([]);
        setPage(0);
      });
  };

  const handleSearch = () => {
    loadSessions({ patientName, dob, startDate, endDate });
  };

  const handleReset = () => {
    setPatientName('');
    setDob('');
    setStartDate('');
    setEndDate('');
    loadSessions({});
  };

  useEffect(() => {
    loadSessions({});
  }, []);

  useEffect(() => {
    setPage((prev) => {
      const maxIndex = Math.max(Math.ceil(sessions.length / PAGE_SIZE) - 1, 0);
      return Math.min(prev, maxIndex);
    });
  }, [sessions.length]);

  const visitTypeLabel = (type: string) => (type === 'initial' ? '初診' : type === 'followup' ? '再診' : type);

  // 一覧の複数選択（行）用
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedSessionIds((prev) => (checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id)));
  };
  const totalPages = Math.max(Math.ceil(sessions.length / PAGE_SIZE), 1);
  const paginatedSessions = sessions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const displayedSessionIds = paginatedSessions.map((s) => s.id);
  const allDisplayedSelected =
    displayedSessionIds.length > 0 && displayedSessionIds.every((id) => selectedSessionIds.includes(id));
  const someDisplayedSelected =
    displayedSessionIds.some((id) => selectedSessionIds.includes(id)) && !allDisplayedSelected;
  const hasSelection = selectedSessionIds.length > 0;
  const getTargetIds = (): string[] => selectedSessionIds;
  const copyTextToClipboard = async (text: string) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  };

  const fetchSessionMarkdown = async (id: string) => {
    const res = await fetch(`/admin/sessions/${encodeURIComponent(id)}/download/md`);
    if (!res.ok) {
      throw new Error('failed to fetch markdown');
    }
    return res.text();
  };

  const copyMarkdownForSession = async (id: string, context: 'modal' | 'row') => {
    try {
      const key = context === 'modal' ? 'modal' : `row-${id}`;
      setCopyingMarkdownTarget(key);
      const text = await fetchSessionMarkdown(id);
      await copyTextToClipboard(text);
      notify({
        title: 'Markdownをコピーしました',
        status: 'success',
        channel: 'admin',
        duration: 3000,
      });
    } catch (err) {
      console.error(err);
      notify({
        title: 'Markdownのコピーに失敗しました',
        status: 'error',
        channel: 'admin',
        duration: 4000,
      });
    } finally {
      setCopyingMarkdownTarget(null);
    }
  };

  const handleBulkDownload = async (fmt: 'pdf' | 'md' | 'csv') => {
    const ids = getTargetIds();
    if (ids.length === 0) return;

    if (fmt === 'md') {
      try {
        setCopyingMarkdownTarget('bulk');
        const sections = await Promise.all(
          ids.map(async (id, index) => {
            const text = await fetchSessionMarkdown(id);
            const session = sessions.find((s) => s.id === id);
            const headerLines = [
              `## ${session?.patient_name ?? '患者'} (${session?.dob ?? '-'})`,
              `- 問診ID: ${id}`,
              session?.visit_type ? `- 受診種別: ${visitTypeLabel(session.visit_type)}` : null,
              session?.finalized_at ? `- 確定日時: ${formatDateTime(session.finalized_at)}` : null,
            ].filter((line): line is string => Boolean(line));
            const separator = index === ids.length - 1 ? '' : '\n\n---\n\n';
            return `${headerLines.join('\n')}\n\n${text.trim()}${separator}`;
          })
        );
        const combined = sections.join('');
        await copyTextToClipboard(combined);
        notify({
          title: `Markdownを${ids.length}件コピーしました`,
          status: 'success',
          channel: 'admin',
          duration: 3000,
        });
      } catch (err) {
        console.error(err);
        notify({
          title: 'Markdownの一括コピーに失敗しました',
          status: 'error',
          channel: 'admin',
          duration: 4000,
        });
      } finally {
        setCopyingMarkdownTarget(null);
      }
      return;
    }

    const qs = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
    const url = `/admin/sessions/bulk/download/${fmt}?${qs}`;
    window.open(url, '_blank');
  };

  const openPreview = async (id: string) => {
    try {
      setLoading(true);
      setSelectedDetail(null);
      setSelectedItems([]);
      preview.onOpen();
      const res = await fetch(`/admin/sessions/${id}`);
      const detail = await res.json();
      const tpl = await fetch(
        `/questionnaires/${detail.questionnaire_id}/template?visit_type=${detail.visit_type}`
      ).then((r) => r.json());
      setSelectedDetail({ ...detail, id });
      const templateItems = tpl.items || [];
      const questionTexts = detail.question_texts ?? {};
      const baseEntries = templateItems.map((it: any) => ({
        id: it.id,
        label: questionTexts[it.id] ?? it.label,
        answer: detail.answers?.[it.id],
      }));
      const templateIds = new Set(templateItems.map((it: any) => it.id));
      const extraIds = Array.from(
        new Set([
          ...Object.keys(questionTexts),
          ...Object.keys(detail.answers ?? {}),
        ])
      )
        .filter((qid) => !templateIds.has(qid) && !qid.startsWith('llm_'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const additionalEntries = extraIds.map((qid) => ({
        id: qid,
        label: questionTexts[qid] ?? qid,
        answer: detail.answers?.[qid],
      }));
      setSelectedItems([...baseEntries, ...additionalEntries]);
    } finally {
      setLoading(false);
    }
  };

  const formatAnswer = (answer: any) => {
    if (answer === null || answer === undefined || answer === '') return <Text color="fg.muted">未回答</Text>;
    if (Array.isArray(answer)) return <Text>{answer.join(', ')}</Text>;
    if (typeof answer === 'object')
      return (
        <Text as="pre" whiteSpace="pre-wrap">
          {JSON.stringify(answer, null, 2)}
        </Text>
      );
    return <Text>{String(answer)}</Text>;
  };

  const formatSummaryText = (summary: string) => summary.replace(/^要約:\s*/, '').replace(/,\s*/g, '\n');

  const reloadWithCurrentFilters = () => {
    loadSessions({ patientName, dob, startDate, endDate });
  };

  // row deletion handled via AlertDialog -> deleteSessionNoConfirm

  const bulkDeleteDisplayedNoConfirm = async () => {
    if (displayedSessionIds.length === 0) return;
    try {
      const qs = displayedSessionIds.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
      const res = await fetch(`/admin/sessions/bulk/delete?${qs}`, { method: 'POST' });
      if (!res.ok) throw new Error('failed');
      const body = await res.json().catch(() => ({} as any));
      const deleted = body?.deleted ?? displayedSessionIds.length;
      notify({
        title: `${deleted}件削除しました`,
        status: 'success',
        channel: 'admin',
        duration: 3000,
      });
      reloadWithCurrentFilters();
    } catch (err) {
      console.error(err);
      notify({
        title: '一括削除に失敗しました',
        status: 'error',
        channel: 'admin',
        duration: 4000,
      });
    }
  };

  const bulkDeleteSelectedNoConfirm = async () => {
    const ids = getTargetIds();
    if (ids.length === 0) return;
    try {
      const qs = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
      const res = await fetch(`/admin/sessions/bulk/delete?${qs}`, { method: 'POST' });
      if (!res.ok) throw new Error('failed');
      const body = await res.json().catch(() => ({} as any));
      const deleted = body?.deleted ?? ids.length;
      notify({
        title: `${deleted}件削除しました`,
        status: 'success',
        channel: 'admin',
        duration: 3000,
      });
      setSelectedSessionIds([]);
      reloadWithCurrentFilters();
    } catch (err) {
      console.error(err);
      notify({
        title: '一括削除に失敗しました',
        status: 'error',
        channel: 'admin',
        duration: 4000,
      });
    }
  };

  const deleteSessionNoConfirm = async (id: string) => {
    try {
      const res = await fetch(`/admin/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed');
      notify({ title: '削除しました', status: 'success', channel: 'admin', duration: 3000 });
      reloadWithCurrentFilters();
    } catch (err) {
      console.error(err);
      notify({ title: '削除に失敗しました', status: 'error', channel: 'admin', duration: 4000 });
    }
  };

  return (
    <>
      <Box
        p={4}
        mb={4}
        bg="white"
        _dark={{ bg: 'gray.900' }}
        borderRadius="lg"
        borderWidth="1px"
        borderColor="border.subtle"
        boxShadow="sm"
      >
        <VStack align="stretch" spacing={4}>
          <HStack spacing={4} align="flex-end">
            <FormControl>
              <FormLabel>患者名</FormLabel>
              <Input
                bg="white"
                _dark={{ bg: 'gray.800' }}
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>生年月日</FormLabel>
              <Input
                type="date"
                bg="white"
                _dark={{ bg: 'gray.800' }}
                value={dob}
                onChange={(e) => setDob(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>問診日(開始)</FormLabel>
              <Input
                type="date"
                bg="white"
                _dark={{ bg: 'gray.800' }}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>問診日(終了)</FormLabel>
              <Input
                type="date"
                bg="white"
                _dark={{ bg: 'gray.800' }}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </FormControl>
          </HStack>
          <Flex align="center" justify="space-between" wrap="wrap" gap={3}>
            <HStack spacing={3}>
              <Menu isLazy>
                <MenuButton as={Button} size="md" leftIcon={<FiFile />} isDisabled={!hasSelection}>
                  一括出力
                </MenuButton>
                <MenuList>
                  <MenuItem onClick={() => handleBulkDownload('pdf')}>PDFをダウンロード</MenuItem>
                  <MenuItem onClick={() => handleBulkDownload('md')} isDisabled={copyingMarkdownTarget === 'bulk'}>
                    Markdownをコピー
                  </MenuItem>
                  <MenuItem onClick={() => handleBulkDownload('csv')}>CSVをダウンロード</MenuItem>
                </MenuList>
              </Menu>
              <Menu isLazy>
                <MenuButton as={Button} size="md" colorScheme="red" isDisabled={!hasSelection}>
                  一括削除
                </MenuButton>
                <MenuList>
                  <MenuItem onClick={() => setConfirmState({ type: 'bulk-selected' })} isDisabled={!hasSelection}>
                    選択を削除
                  </MenuItem>
                  <MenuItem onClick={() => setConfirmState({ type: 'bulk-displayed' })}>
                    表示中を削除
                  </MenuItem>
                </MenuList>
              </Menu>
              <Tag colorScheme="primary" variant={hasSelection ? 'solid' : 'subtle'}>
                {hasSelection ? `選択 ${selectedSessionIds.length} 件` : '未選択'}
              </Tag>
            </HStack>
            <Flex align="center" justify="flex-end" wrap="wrap" gap={3}>
              {(patientName || dob || startDate || endDate) && (
                <Text fontSize="sm" color="fg.muted">
                  フィルタ:
                  {patientName && ` 氏名:${patientName}`}
                  {dob && ` 生年月日:${dob}`}
                  {startDate && ` 開始:${startDate}`}
                  {endDate && ` 終了:${endDate}`}
                </Text>
              )}
              <Button size="md" onClick={handleSearch}>
                検索
              </Button>
              <Button size="md" onClick={handleReset}>
                リセット
              </Button>
            </Flex>
          </Flex>
        </VStack>
      </Box>
      <Box
        bg="white"
        _dark={{ bg: 'gray.900' }}
        borderRadius="lg"
        borderWidth="1px"
        borderColor="border.subtle"
        boxShadow="sm"
        overflow="hidden"
      >
        <Box overflowX="auto">
          <Table>
            <Thead>
              <Tr>
                <Th width="1%">
                  <Checkbox
                    isChecked={allDisplayedSelected}
                    isIndeterminate={someDisplayedSelected}
                    onChange={(e) => {
                      e.stopPropagation();
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
                <Th>問診日</Th>
                <Th>操作</Th>
              </Tr>
            </Thead>
            <Tbody>
              {paginatedSessions.map((s) => {
                const selected = selectedSessionIds.includes(s.id);
                return (
                  <Tr
                    key={s.id}
                    bg={selected ? 'bg.subtle' : undefined}
                    borderLeftWidth={selected ? '4px' : undefined}
                    borderLeftColor={selected ? 'accent.solid' : undefined}
                    _hover={{ bg: 'bg.emphasis' }}
                    onClick={() => openPreview(s.id)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <Td onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        isChecked={selectedSessionIds.includes(s.id)}
                        onChange={(e) => toggleSelect(s.id, (e.target as HTMLInputElement).checked)}
                      />
                    </Td>
                    <Td>{s.patient_name}</Td>
                    <Td>{s.dob}</Td>
                    <Td>{visitTypeLabel(s.visit_type)}</Td>
                    <Td>{formatDate(s.finalized_at)}</Td>
                    <Td onClick={(e) => e.stopPropagation()}>
                      <HStack spacing={3}>
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
                            <MenuItem onClick={() => window.open(`/admin/sessions/${encodeURIComponent(s.id)}/download/pdf`, '_blank')}>
                              PDF
                            </MenuItem>
                            <MenuItem onClick={() => copyMarkdownForSession(s.id, 'row')}>Markdown</MenuItem>
                            <MenuItem onClick={() => window.open(`/admin/sessions/${encodeURIComponent(s.id)}/download/csv`, '_blank')}>
                              CSV
                            </MenuItem>
                          </MenuList>
                        </Menu>
                        <Tooltip label="削除" placement="bottom" hasArrow openDelay={150}>
                          <IconButton
                            size="md"
                            variant="outline"
                            colorScheme="red"
                            icon={<FiTrash />}
                            aria-label="問診結果を削除"
                            minW="44px"
                            minH="44px"
                            onClick={() => setConfirmState({ type: 'row', id: s.id })}
                          />
                        </Tooltip>
                      </HStack>
                    </Td>
                  </Tr>
                );
              })}
              {sessions.length === 0 && (
                <Tr>
                  <Td colSpan={6}>
                    <Text fontSize="sm" color="fg.muted" textAlign="center">
                      条件に一致する問診データがありません。
                    </Text>
                  </Td>
                </Tr>
              )}
            </Tbody>
          </Table>
        </Box>

        <HStack justifyContent="space-between" align="center" px={6} py={4} borderTopWidth="1px" borderColor="border.subtle">
          <Text fontSize="sm" color="fg.muted">
            全体 {sessions.length} 件中 選択 {selectedSessionIds.length} 件
          </Text>
          <HStack spacing={3}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPage((prev) => Math.max(prev - 1, 0))}
              isDisabled={page === 0}
            >
              前のデータ
            </Button>
            <Text fontSize="sm" color="fg.muted">
              ページ {page + 1} / {totalPages}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPage((prev) => Math.min(prev + 1, totalPages - 1))}
              isDisabled={page >= totalPages - 1}
            >
              次のデータ
            </Button>
          </HStack>
        </HStack>
      </Box>

      <Box h={6} />

      <Modal isOpen={preview.isOpen} onClose={preview.onClose} size="4xl" scrollBehavior="inside">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader pr={14}>
            <Flex align="center" width="100%">
              <Heading size="md">問診結果詳細</Heading>
              <Spacer />
              {selectedDetail && (
                <HStack spacing={2}>
                  <Tooltip label="PDF形式で出力" placement="bottom" hasArrow openDelay={150}>
                    <Button
                      size="sm"
                      colorScheme="primary"
                      variant="outline"
                      leftIcon={<FiFile />}
                      onClick={() =>
                        window.open(
                          `/admin/sessions/${encodeURIComponent(selectedDetail.id)}/download/pdf`,
                          '_blank'
                        )
                      }
                    >
                      PDF
                    </Button>
                  </Tooltip>
                  <Tooltip label="Markdown形式をコピー" placement="bottom" hasArrow openDelay={150}>
                    <Button
                      size="sm"
                      colorScheme="primary"
                      variant="outline"
                      leftIcon={<FiFileText />}
                      isLoading={copyingMarkdownTarget === 'modal'}
                      onClick={() => selectedDetail && copyMarkdownForSession(selectedDetail.id, 'modal')}
                    >
                      Markdown
                    </Button>
                  </Tooltip>
                  <Tooltip label="CSV形式で出力" placement="bottom" hasArrow openDelay={150}>
                    <Button
                      size="sm"
                      colorScheme="primary"
                      variant="outline"
                      leftIcon={<FiTable />}
                      onClick={() =>
                        window.open(
                          `/admin/sessions/${encodeURIComponent(selectedDetail.id)}/download/csv`,
                          '_blank'
                        )
                      }
                    >
                      CSV
                    </Button>
                  </Tooltip>
                </HStack>
              )}
            </Flex>
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {loading && (
              <Box py={6} textAlign="center">
                <Spinner color="accent.solid" />
              </Box>
            )}
            {!loading && selectedDetail && (
              <VStack align="stretch" spacing={4}>
                <Box>
                  <Heading size="sm" mb={2}>
                    患者情報
                  </Heading>
                  <VStack align="stretch" spacing={1}>
                    <Text>
                      <strong>患者名:</strong> {selectedDetail.patient_name}
                    </Text>
                    <Text>
                      <strong>生年月日:</strong> {selectedDetail.dob}
                    </Text>
                    <Text>
                      <strong>受診種別:</strong> {visitTypeLabel(selectedDetail.visit_type)}
                    </Text>
                    {/* テンプレートIDの表示は削除 */}
                    <Text>
                      <strong>問診日:</strong> {formatDate(selectedDetail.finalized_at)}
                    </Text>
                  </VStack>
                </Box>
                <Heading size="sm">回答内容</Heading>
                {selectedItems.map((entry: any) => (
                  <AccentOutlineBox key={entry.id} p={3} borderRadius="md">
                    <Text fontWeight="bold" mb={1}>
                      {entry.label}
                    </Text>
                    {formatAnswer(entry.answer)}
                  </AccentOutlineBox>
                ))}
                {selectedDetail.llm_question_texts && Object.keys(selectedDetail.llm_question_texts).length > 0 && (
                  <>
                    <Heading size="sm"></Heading>
                    {Object.entries(selectedDetail.llm_question_texts)
                      .sort(([a]: any, [b]: any) => String(a).localeCompare(String(b), undefined, { numeric: true }))
                      .map(([qid, qtext]: any) => (
                        <AccentOutlineBox key={qid} p={3} borderRadius="md">
                          <Text fontWeight="bold" mb={1}>
                            {(selectedDetail.question_texts ?? {})[qid] ?? qtext}
                          </Text>
                          {formatAnswer(selectedDetail.answers?.[qid])}
                        </AccentOutlineBox>
                      ))}
                  </>
                )}
                {selectedDetail.summary && (
                  <VStack align="stretch" spacing={2} mt={2}>
                    <Heading size="sm">自動生成サマリー</Heading>
                    <AccentOutlineBox p={3} borderRadius="md">
                      <Text whiteSpace="pre-wrap">{formatSummaryText(selectedDetail.summary)}</Text>
                    </AccentOutlineBox>
                  </VStack>
                )}
              </VStack>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>

      {/* 削除確認ダイアログ */}
      <AlertDialog
        isOpen={!!confirmState}
        leastDestructiveRef={cancelRef}
        onClose={() => setConfirmState(null)}
        isCentered
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader>削除の確認</AlertDialogHeader>
            <AlertDialogBody>
              {confirmState?.type === 'bulk-selected' && `選択中の ${selectedSessionIds.length} 件を削除します。よろしいですか？`}
              {confirmState?.type === 'bulk-displayed' && `このページに表示中の ${displayedSessionIds.length} 件を削除します。よろしいですか？`}
              {confirmState?.type === 'row' && `この問診結果を削除します。よろしいですか？`}
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={cancelRef} onClick={() => setConfirmState(null)} variant="ghost">
                キャンセル
              </Button>
              <Button colorScheme="red" ml={3}
                onClick={async () => {
                  if (confirmState?.type === 'bulk-selected') await bulkDeleteSelectedNoConfirm();
                  else if (confirmState?.type === 'bulk-displayed') await bulkDeleteDisplayedNoConfirm();
                  else if (confirmState?.type === 'row' && confirmState.id) await deleteSessionNoConfirm(confirmState.id);
                  setConfirmState(null);
                }}
              >
                削除する
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </>
  );
}
