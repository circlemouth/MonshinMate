import { Container, Heading, Box, Flex, Spacer, Button, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input, FormControl, FormLabel, Text } from '@chakra-ui/react';
import { Routes, Route, Link as RouterLink, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { flushQueue } from './retryQueue';
import FlowProgress from './components/FlowProgress';
import { track } from './metrics';
import Entry from './pages/Entry';
import QuestionnaireForm from './pages/QuestionnaireForm';
import Questions from './pages/Questions';
import Review from './pages/Review';
import Done from './pages/Done';
import AdminLogin from './pages/AdminLogin';
import AdminTemplates from './pages/AdminTemplates';
import AdminLlm from './pages/AdminLlm';
import AdminSessions from './pages/AdminSessions';
import AdminSessionDetail from './pages/AdminSessionDetail';
import LLMChat from './pages/LLMChat';
import AdminLayout from './components/AdminLayout';
import LlmWait from './pages/LlmWait';
import AdminSystemName from './pages/AdminSystemName';

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [loginOpen, setLoginOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  useEffect(() => {
    flushQueue();
  }, []);
  useEffect(() => {
    track('page_view', { path: location.pathname });
  }, [location.pathname]);

  // 管理画面以外へ遷移したら自動的にログアウト（管理ログイン状態の破棄）
  useEffect(() => {
    if (!location.pathname.startsWith('/admin')) {
      sessionStorage.removeItem('adminLoggedIn');
    }
  }, [location.pathname]);

  const isChatPage = location.pathname === '/chat';
  const isAdminPage = location.pathname.startsWith('/admin');
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

  const openAdminLogin = () => {
    setLoginError('');
    setAdminPassword('');
    setLoginOpen(true);
  };

  const closeAdminLogin = () => {
    if (!loginLoading) setLoginOpen(false);
  };

  const handleAdminLogin = async () => {
    if (!adminPassword) {
      setLoginError('パスワードを入力してください');
      return;
    }
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!res.ok) {
        setLoginError('ログインに失敗しました');
        return;
      }
      sessionStorage.setItem('adminLoggedIn', '1');
      setLoginOpen(false);
      navigate('/admin/templates');
    } finally {
      setLoginLoading(false);
    }
  };

  return (
    <Container
      // 管理画面とチャット画面は左右の余白を抑えて全幅表示
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
          <Heading size="lg">{displayName}</Heading>
          <Spacer />
          {isAdminPage ? (
            <Button
              as={RouterLink}
              to="/"
              onClick={() => sessionStorage.removeItem('adminLoggedIn')}
              colorScheme="primary"
              variant="outline"
              size="sm"
            >
              問診画面に戻る
            </Button>
          ) : (
            <Button onClick={openAdminLogin} colorScheme="primary" size="sm">管理画面</Button>
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
          <Route path="/review" element={<Review />} />
          <Route path="/done" element={<Done />} />
          <Route path="/chat" element={<LLMChat />} />

          {/* 管理者系 */}
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<Navigate to="/admin/templates" replace />} />
          <Route path="/admin/system-name" element={<AdminLayout><AdminSystemName /></AdminLayout>} />
          <Route path="/admin/templates" element={<AdminLayout><AdminTemplates /></AdminLayout>} />
          <Route path="/admin/sessions" element={<AdminLayout><AdminSessions /></AdminLayout>} />
          <Route path="/admin/sessions/:id" element={<AdminLayout><AdminSessionDetail /></AdminLayout>} />
          <Route path="/admin/llm" element={<AdminLayout><AdminLlm /></AdminLayout>} />
        </Routes>
      </Box>

      {/* フッター（中央揃え、常に最下部。チャット画面では非表示） */}
      {!isChatPage && (
        <Box as="footer" mt={10} color="gray.600" textAlign="center" pb={2}>
          <Box fontSize="sm">
            本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。
          </Box>
          <Text mt={1} fontSize="xs" color="gray.500">問診メイト</Text>
        </Box>
      )}

      {/* 管理ログイン用モーダル（患者画面→管理画面導線のみで使用） */}
      <Modal isOpen={loginOpen} onClose={closeAdminLogin} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>管理者ログイン</ModalHeader>
          <ModalCloseButton disabled={loginLoading} />
          <ModalBody>
            <FormControl>
              <FormLabel>パスワード</FormLabel>
              <Input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAdminLogin();
                  }
                }}
                autoFocus
              />
            </FormControl>
            {loginError && (
              <Text color="red.500" mt={2} fontSize="sm">{loginError}</Text>
            )}
          </ModalBody>
          <ModalFooter>
            <Button mr={3} onClick={closeAdminLogin} variant="ghost" isDisabled={loginLoading}>キャンセル</Button>
            <Button colorScheme="primary" onClick={handleAdminLogin} isLoading={loginLoading}>ログイン</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Container>
  );
}
