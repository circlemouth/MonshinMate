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
} from '@chakra-ui/react';

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

  useEffect(() => {
    fetch('/admin/sessions').then((r) => r.json()).then(setSessions);
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
      <Table>
        <Thead>
          <Tr>
            <Th>患者名</Th>
            <Th>生年月日</Th>
            <Th>受診種別</Th>
            <Th>確定日時</Th>
          </Tr>
        </Thead>
        <Tbody>
          {sessions.map((s) => (
            <Tr key={s.id} _hover={{ bg: 'gray.50' }} onClick={() => openPreview(s.id)} sx={{ cursor: 'pointer' }}>
              <Td>{s.patient_name}</Td>
              <Td>{s.dob}</Td>
              <Td>{visitTypeLabel(s.visit_type)}</Td>
              <Td>{s.finalized_at || '-'}</Td>
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
