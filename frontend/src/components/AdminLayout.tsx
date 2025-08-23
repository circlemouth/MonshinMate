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
      { label: 'システム表示名', to: '/admin/system-name' },
      { label: 'テンプレート管理', to: '/admin/templates' },
      { label: '問診結果一覧', to: '/admin/sessions' },
      { label: 'LLM設定', to: '/admin/llm' },
      { label: '使い方', to: '/admin/manual' },
    ],
    []
  );

  const logout = () => {
    sessionStorage.removeItem('adminLoggedIn');
    navigate('/admin/login');
  };

  return (
    <Flex align="stretch" gap={4} height="100vh" px={{ base: 2, md: 3 }}>
      <Box
        as="nav"
        minW={{ base: '160px', md: '200px' }}
        position="sticky"
        top={0}
        alignSelf="flex-start"
        maxH="100vh"
        overflowY="auto"
      >
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
        </VStack>
      </Box>
      <Box flex="1" minW={0}>
        {children}
      </Box>
    </Flex>
  );
}
