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
  IconButton,
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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const preview = useDisclosure();

  const [patientName, setPatientName] = useState('');
  const [dob, setDob] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

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
      .then(setSessions);
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

  const visitTypeLabel = (type: string) => (type === 'initial' ? '初診' : type === 'followup' ? '再診' : type);

  const openPreview = async (id: string) => {
    try {
      setLoading(true);
      setSelectedDetail(null);
      setSelectedItems([]);
      preview.onOpen();
      const res = await fetch(`/admin/sessions/${id}`);
      const detail = await res.json();
      setSelectedDetail(detail);
      const tpl = await fetch(
        `/questionnaires/${detail.questionnaire_id}/template?visit_type=${detail.visit_type}`
      ).then((r) => r.json());
      setSelectedItems(tpl.items || []);
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
        <HStack justify="flex-end">
          <Button onClick={handleSearch}>検索</Button>
          <Button onClick={handleReset}>リセット</Button>
        </HStack>
      </VStack>
      <Table>
        <Thead>
          <Tr>
            <Th>患者名</Th>
            <Th>生年月日</Th>
            <Th>受診種別</Th>
            <Th>確定日時</Th>
            <Th>出力</Th>
          </Tr>
        </Thead>
        <Tbody>
          {sessions.map((s) => (
            <Tr key={s.id} _hover={{ bg: 'gray.50' }} onClick={() => openPreview(s.id)} sx={{ cursor: 'pointer' }}>
              <Td>{s.patient_name}</Td>
              <Td>{s.dob}</Td>
              <Td>{visitTypeLabel(s.visit_type)}</Td>
              <Td>{s.finalized_at || '-'}</Td>
              <Td onClick={(e) => e.stopPropagation()}>
                <HStack spacing={1}>
                  <IconButton
                    as="a"
                    href={`/admin/sessions/${s.id}/download/pdf`}
                    aria-label="PDFをダウンロード"
                    icon={<FiFile />}
                    size="sm"
                    variant="ghost"
                  />
                  <IconButton
                    as="a"
                    href={`/admin/sessions/${s.id}/download/md`}
                    aria-label="Markdownをダウンロード"
                    icon={<FiFileText />}
                    size="sm"
                    variant="ghost"
                  />
                  <IconButton
                    as="a"
                    href={`/admin/sessions/${s.id}/download/csv`}
                    aria-label="CSVをダウンロード"
                    icon={<FiTable />}
                    size="sm"
                    variant="ghost"
                  />
                </HStack>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      <Modal isOpen={preview.isOpen} onClose={preview.onClose} size="4xl" scrollBehavior="inside">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>問診結果詳細</ModalHeader>
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
                {selectedItems.map((it: any) => (
                  <Box key={it.id} p={3} borderWidth="1px" borderRadius="md">
                    <Text fontWeight="bold" mb={1}>
                      {it.label}
                    </Text>
                    {formatAnswer(selectedDetail.answers?.[it.id])}
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
                            {qtext}
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
