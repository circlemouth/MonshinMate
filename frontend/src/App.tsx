import { Container, Heading, Box, Flex, Button, Spinner, Center, Text, useDisclosure, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton } from '@chakra-ui/react';
import { Routes, Route, Link as RouterLink, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { flushQueue } from './retryQueue';
import FlowProgress from './components/FlowProgress';
import { useAuth } from './contexts/AuthContext';

// Pages
import Entry from './pages/Entry';
import BasicInfo from './pages/BasicInfo';
import QuestionnaireForm from './pages/QuestionnaireForm';
import Questions from './pages/Questions';
import Done from './pages/Done';
import AdminLogin from './pages/AdminLogin';
import LlmWait from './pages/LlmWait';


// Layouts
import AdminLayout from './components/AdminLayout';
import FontSizeControl from './components/FontSizeControl';
import { useAutoFontSize } from './hooks/useAutoFontSize';
import { loadSystemBootstrap, patchSystemBootstrap } from './systemBootstrap';

const loadAdminMain = () => import('./pages/AdminMain');
const AdminMain = lazy(loadAdminMain);
const AdminTemplates = lazy(() => import('./pages/AdminTemplates'));
const AdminLlm = lazy(() => import('./pages/AdminLlm'));
const AdminSessions = lazy(() => import('./pages/AdminSessions'));
const AdminSessionDetail = lazy(() => import('./pages/AdminSessionDetail'));
const LLMChat = lazy(() => import('./pages/LLMChat'));
const AdminAppearance = lazy(() => import('./pages/AdminAppearance'));
const AdminTimezone = lazy(() => import('./pages/AdminTimezone'));
const AdminManual = lazy(() => import('./pages/AdminManual'));
const AdminLicense = lazy(() => import('./pages/AdminLicense'));
const AdminLicenseDeps = lazy(() => import('./pages/AdminLicenseDeps'));
const AdminDataTransfer = lazy(() => import('./pages/AdminDataTransfer'));
const AdminInitialPassword = lazy(() => import('./pages/AdminInitialPassword'));
const AdminTotpSetup = lazy(() => import('./pages/AdminTotpSetup'));
const AdminPasswordReset = lazy(() => import('./pages/AdminPasswordReset'));
const AdminSecurity = lazy(() => import('./pages/AdminSecurity'));
const AdminApi = lazy(() => import('./pages/AdminApi'));
const AdminPostalCode = lazy(() => import('./pages/AdminPostalCode'));

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoading, isInitialPassword, showTotpSetup, isAuthenticated, logout } = useAuth();

  useEffect(() => {
    flushQueue();
    // ページ遷移時に認証状態をチェック（セッションが切れている場合などに対応）
    // checkAuthStatus(); // AuthProvider内で初回実行済み。必要に応じて追加。
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

  // 管理画面以外へ遷移したら自動的にログアウト（セッションストレージのフラグのみクリア）
  useEffect(() => {
    if (!location.pathname.startsWith('/admin')) {
      logout();
    }
  }, [location.pathname]);

  const [displayName, setDisplayName] = useState('問診メイト');
  const [logo, setLogo] = useState<{ url: string | null; crop: { x: number; y: number; w: number; h: number } | null }>({ url: null, crop: null });
  const systemNameRef = useRef<HTMLHeadingElement>(null);

  // システム表示名の取得と更新イベント購読
  useEffect(() => {
    const fetchName = async () => {
      try {
        const settings = await loadSystemBootstrap();
        setDisplayName(settings.display_name);
        setLogo(settings.logo);
      } catch {}
    };
    fetchName();
    const onUpdated = (e: any) => {
      const name = e?.detail;
      if (typeof name === 'string' && name) {
        setDisplayName(name);
        patchSystemBootstrap({ display_name: name });
      }
    };
    window.addEventListener('systemDisplayNameUpdated' as any, onUpdated);
    const onLogoUpdated = (e: any) => {
      const d = e?.detail || {};
      setLogo({ url: d.url ?? null, crop: d.crop ?? null });
      patchSystemBootstrap({ logo: { url: d.url ?? null, crop: d.crop ?? null } });
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
    void loadAdminMain();
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
          <Box alignSelf={{ base: 'flex-end', md: 'center' }} mt={{ base: 2, md: 0 }} ml={{ base: 0, md: 'auto' }}>
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
        <Suspense fallback={<Center minH="40vh"><Spinner size="lg" /></Center>}>
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
            <Route element={<AdminLayout />}>
              <Route path="/admin/main" element={<AdminMain />} />
              <Route path="/admin/appearance" element={<AdminAppearance />} />
              <Route path="/admin/timezone" element={<AdminTimezone />} />
              <Route path="/admin/data-transfer" element={<AdminDataTransfer />} />
              <Route path="/admin/templates" element={<AdminTemplates />} />
              <Route path="/admin/sessions" element={<AdminSessions />} />
              <Route path="/admin/sessions/:id" element={<AdminSessionDetail />} />
              <Route path="/admin/llm" element={<AdminLlm />} />
              <Route path="/admin/api" element={<AdminApi />} />
              <Route path="/admin/postal-code" element={<AdminPostalCode />} />
              <Route path="/admin/security" element={<AdminSecurity />} />
              <Route path="/admin/manual" element={<AdminManual />} />
              <Route path="/admin/license" element={<AdminLicense />} />
              <Route path="/admin/license/dependencies" element={<AdminLicenseDeps />} />
            </Route>
          </Routes>
        </Suspense>
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
