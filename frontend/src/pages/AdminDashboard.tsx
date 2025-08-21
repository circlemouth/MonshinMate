import { useEffect } from 'react';
import { VStack, Button } from '@chakra-ui/react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

/** 管理画面ダッシュボード。 */
export default function AdminDashboard() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
    }
  }, [navigate]);

  return (
    <VStack spacing={4} align="stretch">
      <Button as={RouterLink} to="/admin/templates" colorScheme="primary">
        テンプレート管理
      </Button>
      <Button as={RouterLink} to="/admin/sessions" colorScheme="primary" variant="outline">
        問診結果一覧
      </Button>
      <Button as={RouterLink} to="/admin/llm" colorScheme="primary" variant="outline">
        LLM設定
      </Button>
    </VStack>
  );
}
