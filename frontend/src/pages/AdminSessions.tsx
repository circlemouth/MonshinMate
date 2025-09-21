import { useEffect, useState } from 'react';
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
  HStack,
  Tooltip,
  Checkbox,
  Flex,
  Spacer,
  useToast,
} from '@chakra-ui/react';
import { FiFile, FiFileText, FiTable } from 'react-icons/fi';

interface SessionSummary {
  id: string;
  patient_name: string;
  dob: string;
  visit_type: string;
  finalized_at?: string | null;
}

/** 管理画面: セッション一覧。 */
export default function AdminSessions() {
  const PAGE_SIZE = 20;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [copyingMarkdownTarget, setCopyingMarkdownTarget] = useState<string | null>(null);
  const preview = useDisclosure();
  const toast = useToast();

  const [patientName, setPatientName] = useState('');
  const [dob, setDob] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(0);

  const loadSessions = (filters: {
    patientName?: string;
    dob?: string;
    startDate?: string;
    endDate?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters.patientName) params.append('patient_name', filters.patientName);
    if (filters.dob) params.append('dob', filters.dob);
    if (filters.startDate) params.append('start_date', filters.startDate);
    if (filters.endDate) params.append('end_date', filters.endDate);
    const qs = params.toString();
    fetch(`/admin/sessions${qs ? `?${qs}` : ''}`)
      .then((r) => r.json())
      .then((data) => {
        setSessions(data);
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
              session?.finalized_at ? `- 確定日時: ${session.finalized_at}` : null,
            ].filter((line): line is string => Boolean(line));
            const separator = index === ids.length - 1 ? '' : '\n\n---\n\n';
            return `${headerLines.join('\n')}\n\n${text.trim()}${separator}`;
          })
        );
        const combined = sections.join('');
        await copyTextToClipboard(combined);
        toast({
          title: `Markdownを${ids.length}件コピーしました`,
          status: 'success',
          duration: 3000,
          isClosable: true,
          position: 'top-right',
        });
      } catch (err) {
        console.error(err);
        toast({
          title: 'Markdownの一括コピーに失敗しました',
          status: 'error',
          duration: 4000,
          isClosable: true,
          position: 'top-right',
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
    if (answer === null || answer === undefined || answer === '') return <Text color="gray.500">未回答</Text>;
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

  return (
    <>
      <VStack align="stretch" spacing={4} mb={4}>
        <HStack spacing={4} align="flex-end">
          <FormControl>
            <FormLabel>患者名</FormLabel>
            <Input value={patientName} onChange={(e) => setPatientName(e.target.value)} />
          </FormControl>
          <FormControl>
            <FormLabel>生年月日</FormLabel>
            <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          </FormControl>
          <FormControl>
            <FormLabel>問診日(開始)</FormLabel>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </FormControl>
          <FormControl>
            <FormLabel>問診日(終了)</FormLabel>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </FormControl>
        </HStack>
        <HStack justifyContent="flex-end">
          <Button onClick={handleSearch}>検索</Button>
          <Button onClick={handleReset}>リセット</Button>
        </HStack>
        <HStack spacing={2}>
          <Text fontSize="sm" color="gray.600">一括出力（選択されたデータのみ）</Text>
          <Tooltip label="PDF一括ダウンロード" placement="top" hasArrow openDelay={150}>
            <Button
              size="sm"
              colorScheme="blue"
              leftIcon={<FiFile />}
              onClick={() => handleBulkDownload('pdf')}
              isDisabled={!hasSelection}
            >
              PDF
            </Button>
          </Tooltip>
          <Tooltip label="Markdown一括コピー" placement="top" hasArrow openDelay={150}>
            <Button
              size="sm"
              colorScheme="blue"
              leftIcon={<FiFileText />}
              onClick={() => handleBulkDownload('md')}
              isDisabled={!hasSelection}
              isLoading={copyingMarkdownTarget === 'bulk'}
            >
              Markdown
            </Button>
          </Tooltip>
          <Tooltip label="CSV一括ダウンロード" placement="top" hasArrow openDelay={150}>
            <Button
              size="sm"
              colorScheme="blue"
              leftIcon={<FiTable />}
              onClick={() => handleBulkDownload('csv')}
              isDisabled={!hasSelection}
            >
              CSV
            </Button>
          </Tooltip>
        </HStack>
      </VStack>
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
            <Th>確定日時</Th>
            <Th>出力</Th>
          </Tr>
        </Thead>
        <Tbody>
          {paginatedSessions.map((s) => (
            <Tr key={s.id} _hover={{ bg: 'gray.50' }} onClick={() => openPreview(s.id)} sx={{ cursor: 'pointer' }}>
              <Td onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  isChecked={selectedSessionIds.includes(s.id)}
                  onChange={(e) => toggleSelect(s.id, (e.target as HTMLInputElement).checked)}
                />
              </Td>
              <Td>{s.patient_name}</Td>
              <Td>{s.dob}</Td>
              <Td>{visitTypeLabel(s.visit_type)}</Td>
              <Td>{s.finalized_at || '-'}</Td>
              <Td onClick={(e) => e.stopPropagation()}>
                <HStack spacing={1}>
                  {/* 出力形式のホバーツールチップを追加 */}
                  <Tooltip label="PDF形式" placement="top" hasArrow openDelay={150}>
                    <Button
                      size="sm"
                      colorScheme="blue"
                      variant="outline"
                      leftIcon={<FiFile />}
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(`/admin/sessions/${encodeURIComponent(s.id)}/download/pdf`, '_blank');
                      }}
                    >
                      PDF
                    </Button>
                  </Tooltip>
                  <Tooltip label="Markdown形式をコピー" placement="top" hasArrow openDelay={150}>
                    <Button
                      size="sm"
                      colorScheme="blue"
                      variant="outline"
                      leftIcon={<FiFileText />}
                      isLoading={copyingMarkdownTarget === `row-${s.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        copyMarkdownForSession(s.id, 'row');
                      }}
                    >
                      Markdown
                    </Button>
                  </Tooltip>
                  <Tooltip label="CSV形式" placement="top" hasArrow openDelay={150}>
                    <Button
                      size="sm"
                      colorScheme="blue"
                      variant="outline"
                      leftIcon={<FiTable />}
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(`/admin/sessions/${encodeURIComponent(s.id)}/download/csv`, '_blank');
                      }}
                    >
                      CSV
                    </Button>
                  </Tooltip>
                </HStack>
              </Td>
            </Tr>
          ))}
          {sessions.length === 0 && (
            <Tr>
              <Td colSpan={6}>
                <Text fontSize="sm" color="gray.500" textAlign="center">
                  条件に一致する問診データがありません。
                </Text>
              </Td>
            </Tr>
          )}
        </Tbody>
      </Table>

      <HStack justifyContent="space-between" align="center" mt={3} mb={6}>
        <Text fontSize="sm" color="gray.600">
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
          <Text fontSize="sm" color="gray.600">
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
                      colorScheme="blue"
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
                      colorScheme="blue"
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
                      colorScheme="blue"
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
                <Spinner />
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
                    <Text>
                      <strong>テンプレートID:</strong> {selectedDetail.questionnaire_id}
                    </Text>
                    <Text>
                      <strong>確定日時:</strong> {selectedDetail.finalized_at || '-'}
                    </Text>
                  </VStack>
                </Box>
                <Heading size="sm">回答内容</Heading>
                {selectedItems.map((entry: any) => (
                  <Box key={entry.id} p={3} borderWidth="1px" borderRadius="md">
                    <Text fontWeight="bold" mb={1}>
                      {entry.label}
                    </Text>
                    {formatAnswer(entry.answer)}
                  </Box>
                ))}
                {selectedDetail.llm_question_texts && Object.keys(selectedDetail.llm_question_texts).length > 0 && (
                  <>
                    <Heading size="sm"></Heading>
                    {Object.entries(selectedDetail.llm_question_texts)
                      .sort(([a]: any, [b]: any) => String(a).localeCompare(String(b), undefined, { numeric: true }))
                      .map(([qid, qtext]: any) => (
                        <Box key={qid} p={3} borderWidth="1px" borderRadius="md" bg="gray.50">
                          <Text fontWeight="bold" mb={1}>
                            {(selectedDetail.question_texts ?? {})[qid] ?? qtext}
                          </Text>
                          {formatAnswer(selectedDetail.answers?.[qid])}
                        </Box>
                      ))}
                  </>
                )}
                {selectedDetail.summary && (
                  <VStack align="stretch" spacing={2} mt={2}>
                    <Heading size="sm">自動生成サマリー</Heading>
                    <Box p={3} borderWidth="1px" borderRadius="md" bg="gray.50">
                      <Text whiteSpace="pre-wrap">{formatSummaryText(selectedDetail.summary)}</Text>
                    </Box>
                  </VStack>
                )}
              </VStack>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
