import { ReactNode, useMemo, useEffect } from 'react';
import { Box, Flex, VStack, Button, Text, Spacer } from '@chakra-ui/react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';

/**
 * 管理画面用レイアウト。
 * 左側にナビゲーションメニューを配置し、右側に各管理画面の内容を表示する。
 * 本コンポーネントはルーティング上のレイアウトとして使用されることを想定。
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname;

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
    }
  }, [navigate]);

  const navItems = useMemo(
    () => [
      { label: 'テンプレート管理', to: '/admin/templates' },
      { label: '問診結果一覧', to: '/admin/sessions' },
      { label: 'LLM設定', to: '/admin/llm' },
    ],
    []
  );

  const logout = () => {
    sessionStorage.removeItem('adminLoggedIn');
    navigate('/admin/login');
  };

  return (
    <Flex align="stretch" gap={6} height="100vh">
      <Box as="nav" minW={{ base: '180px', md: '220px' }}>
        <VStack align="stretch" spacing={2} height="100%">
          <Text fontSize="sm" color="gray.500" mb={1}>
            管理メニュー
          </Text>
          {navItems.map((item) => {
            const active = current === item.to;
            return (
              <Button
                key={item.to}
                as={RouterLink}
                to={item.to}
                justifyContent="flex-start"
                variant={active ? 'solid' : 'ghost'}
                colorScheme="primary"
              >
                {item.label}
              </Button>
            );
          })}
          <Spacer />
          <Button onClick={logout} justifyContent="flex-start" variant="ghost">
            ログアウト
          </Button>
        </VStack>
      </Box>
      <Box flex="1" minW={0}>
        {children}
      </Box>
    </Flex>
  );
}

