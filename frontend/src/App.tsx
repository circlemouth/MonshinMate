import { Container, Heading, Box, Flex, Spacer, Button, Spinner, Center, Text, useDisclosure, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton } from '@chakra-ui/react';
import { Routes, Route, Link as RouterLink, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { flushQueue } from './retryQueue';
import FlowProgress from './components/FlowProgress';
import { track } from './metrics';
import { useAuth } from './contexts/AuthContext';

// Pages
import Entry from './pages/Entry';
import QuestionnaireForm from './pages/QuestionnaireForm';
import Questions from './pages/Questions';
import Done from './pages/Done';
import AdminLogin from './pages/AdminLogin';
import AdminTemplates from './pages/AdminTemplates';
import AdminLlm from './pages/AdminLlm';
import AdminSessions from './pages/AdminSessions';
import AdminSessionDetail from './pages/AdminSessionDetail';
import LLMChat from './pages/LLMChat';
import LlmWait from './pages/LlmWait';
import AdminAppearance from './pages/AdminAppearance';
import AdminManual from './pages/AdminManual';
import AdminLicense from './pages/AdminLicense';
import AdminInitialPassword from './pages/AdminInitialPassword';
import AdminTotpSetup from './pages/AdminTotpSetup';
import AdminPasswordReset from './pages/AdminPasswordReset';
import AdminSecurity from './pages/AdminSecurity';


// Layouts
import AdminLayout from './components/AdminLayout';
import LlmStatusBadge from './components/LlmStatusBadge';
import FontSizeControl from './components/FontSizeControl';
import { refreshLlmStatus } from './utils/llmStatus';

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoading, isInitialPassword, showTotpSetup, isAuthenticated, logout } = useAuth();

  useEffect(() => {
    flushQueue();
    // ページ遷移時に認証状態をチェック（セッションが切れている場合などに対応）
    // checkAuthStatus(); // AuthProvider内で初回実行済み。必要に応じて追加。
    // 疎通チェックは初期画面（エントリ）表示時のみ行う
    if (location.pathname === '/') {
      refreshLlmStatus();
    }
    // サブページをリロードした場合はトップページへリダイレクト
    try {
      const navs: any = (performance as any).getEntriesByType?.('navigation') || [];
      const navType = navs[0]?.type ?? (performance as any).navigation?.type; // 1 = reload (deprecated API)
      const isReload = navType === 'reload' || navType === 1;
      if (isReload && location.pathname !== '/') {
        navigate('/');
      }
    } catch {}
  }, []);

  useEffect(() => {
    track('page_view', { path: location.pathname });
    // 疎通チェックは初期画面に戻ったときのみ行う
    if (location.pathname === '/') {
      refreshLlmStatus();
    }
  }, [location.pathname]);

  // 管理画面以外へ遷移したら自動的にログアウト（セッションストレージのフラグのみクリア）
  useEffect(() => {
    if (!location.pathname.startsWith('/admin')) {
      logout();
    }
  }, [location.pathname]);

  const [displayName, setDisplayName] = useState('Monshinクリニック');

  // システム表示名の取得と更新イベント購読
  useEffect(() => {
    const fetchName = async () => {
      try {
        const r = await fetch('/system/display-name');
        if (r.ok) {
          const d = await r.json();
          if (d?.display_name) setDisplayName(d.display_name);
        }
      } catch {}
    };
    fetchName();
    const onUpdated = (e: any) => {
      const name = e?.detail;
      if (typeof name === 'string' && name) setDisplayName(name);
    };
    window.addEventListener('systemDisplayNameUpdated' as any, onUpdated);
    return () => window.removeEventListener('systemDisplayNameUpdated' as any, onUpdated);
  }, []);

  const { isOpen: isLoginOpen, onOpen: openLogin, onClose: closeLogin } = useDisclosure();

  // 管理画面ボタン押下時にログイン用モーダルを開く
  const handleAdminClick = () => {
    if (isAuthenticated) {
      navigate('/admin/templates');
    } else {
      openLogin();
    }
  };

  const isChatPage = location.pathname === '/chat';
  const isAdminPage = location.pathname.startsWith('/admin');

  // --- 強制表示ロジック（患者対話画面に限定） ---
  if (isLoading) {
    return (
      <Center h="100vh">
        <Spinner size="xl" />
      </Center>
    );
  }

  if (isChatPage && isInitialPassword) {
    return <AdminInitialPassword />;
  }

  if (showTotpSetup) {
    return <AdminTotpSetup />;
  }
  // -----------------------------------------

  return (
    <Container
      maxW={isChatPage || isAdminPage ? '100%' : 'container.md'}
      py={isChatPage ? 0 : 10}
      px={isChatPage || isAdminPage ? 2 : 4}
      h={isChatPage ? '100vh' : 'auto'}
      minH="100vh"
      display="flex"
      flexDirection="column"
    >
      {!isChatPage && (
        <Flex as="header" mb={4} align="center">
          <Heading size="lg">{isAdminPage ? '管理画面' : displayName}</Heading>
          <Spacer />
          {isAdminPage ? (
            <>
              <LlmStatusBadge />
              <Button
              as={RouterLink}
              to="/"
              onClick={logout}
              colorScheme="primary"
              variant="outline"
              size="sm"
              >
                問診画面に戻る
              </Button>
            </>
          ) : (
            <>
              <LlmStatusBadge />
              <Button onClick={handleAdminClick} colorScheme="primary" size="sm">管理画面</Button>
            </>
          )}
        </Flex>
      )}

      <Box flex="1" overflowY={isAdminPage ? 'visible' : 'auto'}>
        {!isChatPage && <FlowProgress />}
        <Routes>
          <Route path="/" element={<Entry />} />
          <Route path="/questionnaire" element={<QuestionnaireForm />} />
          <Route path="/llm-wait" element={<LlmWait />} />
          <Route path="/questions" element={<Questions />} />
          <Route path="/done" element={<Done />} />
          <Route path="/chat" element={<LLMChat />} />

          {/* 管理者系 */}
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin/initial-password" element={<AdminInitialPassword />} />
          <Route path="/admin/password/reset" element={<AdminPasswordReset />} />
          <Route path="/admin" element={<Navigate to="/admin/templates" replace />} />
          <Route path="/admin/appearance" element={<AdminLayout><AdminAppearance /></AdminLayout>} />
          <Route path="/admin/templates" element={<AdminLayout><AdminTemplates /></AdminLayout>} />
          <Route path="/admin/sessions" element={<AdminLayout><AdminSessions /></AdminLayout>} />
          <Route path="/admin/sessions/:id" element={<AdminLayout><AdminSessionDetail /></AdminLayout>} />
          <Route path="/admin/llm" element={<AdminLayout><AdminLlm /></AdminLayout>} />
          <Route path="/admin/security" element={<AdminLayout><AdminSecurity /></AdminLayout>} />
          <Route path="/admin/manual" element={<AdminLayout><AdminManual /></AdminLayout>} />
          <Route path="/admin/license" element={<AdminLayout><AdminLicense /></AdminLayout>} />
        </Routes>
      </Box>

      {!isChatPage && !isAdminPage && (
        <Box as="footer" mt={10} color="gray.600" textAlign="center" pb={2}>
          <Box fontSize="sm">
            本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。
          </Box>
          <Text mt={1} fontSize="xs" color="gray.500">MonshinMate</Text>
        </Box>
      )}

      <Modal isOpen={isLoginOpen} onClose={closeLogin} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalCloseButton />
          <ModalBody>
            <AdminLogin inModal onSuccess={closeLogin} />
          </ModalBody>
        </ModalContent>
      </Modal>
      {/* 患者側画面のみ、右下にフォントサイズ調整を常時表示 */}
      {!isAdminPage && <FontSizeControl />}
    </Container>
  );
}
