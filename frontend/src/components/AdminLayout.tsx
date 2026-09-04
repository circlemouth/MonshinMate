import { useMemo, useEffect } from 'react';
import { Box, Center, Flex, VStack, Button, Text, Spacer, Spinner } from '@chakra-ui/react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSessionCompletionWatcher } from '../hooks/useSessionCompletionWatcher';
import { useAuth } from '../contexts/AuthContext';

/**
 * 管理画面用レイアウト。
 * 左側にナビゲーションメニューを配置し、右側に各管理画面の内容を表示する。
 * 本コンポーネントはルーティング上のレイアウトとして使用されることを想定。
 */
export default function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname;
  const { isAuthenticated, isLoading } = useAuth();

  useSessionCompletionWatcher(!isLoading && isAuthenticated);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/admin/login');
    }
  }, [isAuthenticated, isLoading, navigate]);

  const navItems = useMemo(
    () => [
      { label: 'ダッシュボード', to: '/admin/main' },
      { label: 'テンプレート管理', to: '/admin/templates' },
      { label: '問診結果一覧', to: '/admin/sessions' },
      { label: 'LLM設定', to: '/admin/llm' },
      { label: 'API連携', to: '/admin/api' },
      { label: '郵便番号辞書', to: '/admin/postal-code' },
      { label: '外観・通知設定', to: '/admin/appearance' },
      { label: 'タイムゾーン設定', to: '/admin/timezone' },
      { label: 'セキュリティ', to: '/admin/security' },
      { label: 'バックアップ', to: '/admin/data-transfer' },
      { label: 'システム説明', to: '/admin/manual' },
      { label: 'ライセンス', to: '/admin/license' },
    ],
    []
  );

  if (isLoading || !isAuthenticated) {
    return (
      <Center minH="50vh">
        <Spinner size="lg" />
      </Center>
    );
  }

  return (
    <Flex direction="column" height="100vh">
      {/* LLM 接続状態の表示は App.tsx のヘッダーに小さく配置する運用に変更 */}
      <Flex align="stretch" gap={4} flex="1" px={{ base: 2, md: 3 }}>
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
            <Text fontSize="sm" color="fg.muted" mb={1}>
              管理メニュー
            </Text>
            {navItems.map((item) => {
              const active = current === item.to || current.startsWith(`${item.to}/`);
              return (
                <Button
                  key={item.to}
                  as={RouterLink}
                  to={item.to}
                  justifyContent="flex-start"
                  variant="ghost"
                  bg={active ? 'bg.subtle' : 'transparent'}
                  color={active ? 'fg.accent' : 'fg.muted'}
                  borderLeftWidth="4px"
                  borderLeftColor={active ? 'accent.solid' : 'transparent'}
                  _hover={{ bg: 'bg.subtle', color: 'fg.accent' }}
                  _active={{ bg: 'bg.emphasis' }}
                  transition="all 0.15s"
                >
                  {item.label}
                </Button>
              );
            })}
            <Spacer />
          </VStack>
        </Box>
        <Box flex="1" minW={0}>
          <Outlet />
        </Box>
      </Flex>
    </Flex>
  );
}
