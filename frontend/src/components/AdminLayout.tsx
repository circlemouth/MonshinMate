import { ReactNode, useMemo, useEffect, useState } from 'react';
import { Box, Flex, VStack, Button, Text, Spacer } from '@chakra-ui/react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';
import { LlmStatus } from '../utils/llmStatus';

/**
 * 管理画面用レイアウト。
 * 左側にナビゲーションメニューを配置し、右側に各管理画面の内容を表示する。
 * 本コンポーネントはルーティング上のレイアウトとして使用されることを想定。
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname;
  const [llmStatus, setLlmStatus] = useState<LlmStatus>('disabled');

  useEffect(() => {
    if (!sessionStorage.getItem('adminLoggedIn')) {
      navigate('/admin/login');
    }
  }, [navigate]);

  useEffect(() => {
    let mounted = true;
    const onUpdated = (e: any) => {
      if (!mounted) return;
      const st = (e?.detail as LlmStatus) ?? 'ng';
      setLlmStatus(st);
    };
    window.addEventListener('llmStatusUpdated' as any, onUpdated);
    return () => {
      mounted = false;
      window.removeEventListener('llmStatusUpdated' as any, onUpdated);
    };
  }, []);

  const navItems = useMemo(
    () => [
      { label: 'テンプレート管理', to: '/admin/templates' },
      { label: '問診結果一覧', to: '/admin/sessions' },
      { label: 'LLM設定', to: '/admin/llm' },
      { label: 'セキュリティ', to: '/admin/security' },
      { label: '表示設定', to: '/admin/appearance' },
      { label: 'バックアップ', to: '/admin/data-transfer' },
      { label: 'システム説明', to: '/admin/manual' },
      { label: 'ライセンス', to: '/admin/license' },
    ],
    []
  );

  const logout = () => {
    sessionStorage.removeItem('adminLoggedIn');
    navigate('/admin/login');
  };

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
    </Flex>
  );
}
