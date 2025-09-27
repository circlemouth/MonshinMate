import { Container, Heading, Box, Flex, Button, Spinner, Center, Text, useDisclosure, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton } from '@chakra-ui/react';
import { Routes, Route, Link as RouterLink, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { flushQueue } from './retryQueue';
import FlowProgress from './components/FlowProgress';
import { track } from './metrics';
import { useAuth } from './contexts/AuthContext';

// Pages
import Entry from './pages/Entry';
import BasicInfo from './pages/BasicInfo';
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
import AdminTimezone from './pages/AdminTimezone';
import AdminManual from './pages/AdminManual';
import AdminLicense from './pages/AdminLicense';
import AdminLicenseDeps from './pages/AdminLicenseDeps';
import AdminDataTransfer from './pages/AdminDataTransfer';
import AdminInitialPassword from './pages/AdminInitialPassword';
import AdminTotpSetup from './pages/AdminTotpSetup';
import AdminPasswordReset from './pages/AdminPasswordReset';
import AdminSecurity from './pages/AdminSecurity';
import AdminMain from './pages/AdminMain';
// removed: yubinbango preload


// Layouts
import AdminLayout from './components/AdminLayout';
import FontSizeControl from './components/FontSizeControl';
import { refreshLlmStatus } from './utils/llmStatus';
import { useAutoFontSize } from './hooks/useAutoFontSize';

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoading, isInitialPassword, showTotpSetup, isAuthenticated, logout } = useAuth();
  // removed: postal-code address lookup preload

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
  const [logo, setLogo] = useState<{ url: string | null; crop: { x: number; y: number; w: number; h: number } | null }>({ url: null, crop: null });
  const systemNameRef = useRef<HTMLHeadingElement>(null);

  // システム表示名の取得と更新イベント購読
  useEffect(() => {
    const fetchName = async () => {
      try {
        const r = await fetch('/system/display-name');
        if (r.ok) {
          const d = await r.json();
          if (d?.display_name) setDisplayName(d.display_name);
        }
        const lr = await fetch('/system/logo');
        if (lr.ok) {
          const ld = await lr.json();
          setLogo({ url: ld?.url ?? null, crop: ld?.crop ?? null });
        }
      } catch {}
    };
    fetchName();
    const onUpdated = (e: any) => {
      const name = e?.detail;
      if (typeof name === 'string' && name) setDisplayName(name);
    };
    window.addEventListener('systemDisplayNameUpdated' as any, onUpdated);
    const onLogoUpdated = (e: any) => {
      const d = e?.detail || {};
      setLogo({ url: d.url ?? null, crop: d.crop ?? null });
    };
    window.addEventListener('systemLogoUpdated' as any, onLogoUpdated);
    return () => {
      window.removeEventListener('systemDisplayNameUpdated' as any, onUpdated);
      window.removeEventListener('systemLogoUpdated' as any, onLogoUpdated);
    };
  }, []);

  const { isOpen: isLoginOpen, onOpen: openLogin, onClose: closeLogin } = useDisclosure();

  // 管理画面ボタン押下時にログイン用モーダルを開く
  const handleAdminClick = () => {
    if (isAuthenticated) {
      navigate('/admin/main');
    } else {
      openLogin();
    }
  };

  const isChatPage = location.pathname === '/chat';
  const isAdminPage = location.pathname.startsWith('/admin');
  const isAdditionalQuestionPage = location.pathname === '/questions';

  useAutoFontSize(systemNameRef, isAdminPage ? '管理画面' : displayName, { minSize: 12 });

  // パスワードリセット画面へ遷移した場合は、ログイン用モーダルを閉じる
  useEffect(() => {
    if (location.pathname.startsWith('/admin/password/reset')) {
      closeLogin();
    }
  }, [location.pathname]);

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
        <Flex
          as="header"
          mb={4}
          pb={3}
          align={{ base: 'stretch', md: 'center' }}
          direction={{ base: 'column', md: 'row' }}
          gap={{ base: 2, md: 0 }}
          boxShadow="inset 0 -1px 0 var(--chakra-colors-border-accent)"
        >
          <Flex align="center" gap={2} minW={0} flex="1">
            {/* Logo/Icon */}
            {logo.url && (
              <Box w="28px" h="28px" borderRadius="full" overflow="hidden" bg="gray.100" flexShrink={0}>
                <img
                  src={logo.url}
                  alt="logo"
                  style={(() => {
                    const c = logo.crop || { x: 0, y: 0, w: 1, h: 1 };
                    const transform = `translate(${-c.x * 100}%, ${-c.y * 100}%) scale(${1 / (c.w || 1)})`;
                    return { width: '100%', height: 'auto', transform, transformOrigin: 'top left', display: 'block' };
                  })()}
                />
              </Box>
            )}
            <Heading
              ref={systemNameRef}
              size={{ base: 'md', md: 'lg' }}
              whiteSpace={{ base: 'normal', md: 'nowrap' }}
              maxW="100%"
              minW={0}
              flexShrink={1}
              wordBreak="break-word"
              title={isAdminPage ? '管理画面' : displayName}
            >
              {isAdminPage ? '管理画面' : displayName}
            </Heading>
          </Flex>
          <Box alignSelf={{ base: 'flex-start', md: 'center' }} mt={{ base: 2, md: 0 }}>
            {isAdminPage ? (
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
            ) : (
              <Button onClick={handleAdminClick} colorScheme="primary" size="sm">
                管理画面
              </Button>
            )}
          </Box>
        </Flex>
      )}

      <Box flex="1" overflowY={isAdminPage ? 'visible' : 'auto'}>
        {!isChatPage && <FlowProgress />}
        <Routes>
          <Route path="/" element={<Entry />} />
          <Route path="/basic-info" element={<BasicInfo />} />
          <Route path="/questionnaire" element={<QuestionnaireForm />} />
          <Route path="/llm-wait" element={<LlmWait />} />
          <Route path="/questions" element={<Questions />} />
          <Route path="/done" element={<Done />} />
          <Route path="/chat" element={<LLMChat />} />

          {/* 管理者系 */}
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin/initial-password" element={<AdminInitialPassword />} />
          <Route path="/admin/password/reset" element={<AdminPasswordReset />} />
          <Route path="/admin" element={<Navigate to="/admin/main" replace />} />
          <Route path="/admin/main" element={<AdminLayout><AdminMain /></AdminLayout>} />
          <Route path="/admin/appearance" element={<AdminLayout><AdminAppearance /></AdminLayout>} />
          <Route path="/admin/timezone" element={<AdminLayout><AdminTimezone /></AdminLayout>} />
          <Route path="/admin/data-transfer" element={<AdminLayout><AdminDataTransfer /></AdminLayout>} />
          <Route path="/admin/templates" element={<AdminLayout><AdminTemplates /></AdminLayout>} />
          <Route path="/admin/sessions" element={<AdminLayout><AdminSessions /></AdminLayout>} />
          <Route path="/admin/sessions/:id" element={<AdminLayout><AdminSessionDetail /></AdminLayout>} />
          <Route path="/admin/llm" element={<AdminLayout><AdminLlm /></AdminLayout>} />
          <Route path="/admin/security" element={<AdminLayout><AdminSecurity /></AdminLayout>} />
          <Route path="/admin/manual" element={<AdminLayout><AdminManual /></AdminLayout>} />
          <Route path="/admin/license" element={<AdminLayout><AdminLicense /></AdminLayout>} />
          <Route path="/admin/license/dependencies" element={<AdminLayout><AdminLicenseDeps /></AdminLayout>} />
        </Routes>
      </Box>

      {isAdditionalQuestionPage && (
        <Box as="footer" mt={10} color="fg.muted" textAlign="center" pb={2}>
          <Box fontSize="sm">
            質問文はローカルAIが生成しています。分かる範囲でご回答をお願いします。
          </Box>
          <Text mt={1} fontSize="xs" color="fg.accent">MonshinMate</Text>
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
