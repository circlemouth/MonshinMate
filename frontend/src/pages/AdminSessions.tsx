import { useEffect, useState } from 'react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { Table, Thead, Tbody, Tr, Th, Td, Link } from '@chakra-ui/react';

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
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
      return;
    }
    fetch('/admin/sessions')
      .then((r) => r.json())
      .then(setSessions);
  }, [navigate]);

  return (
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
          <Tr key={s.id}>
            <Td>
              <Link as={RouterLink} to={`/admin/sessions/${s.id}`}>{s.patient_name}</Link>
            </Td>
            <Td>{s.dob}</Td>
            <Td>{s.visit_type}</Td>
            <Td>{s.finalized_at || '-'}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}
