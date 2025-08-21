import { Container, Heading, Box, Flex, Spacer, Button } from '@chakra-ui/react';
import { Routes, Route, Link as RouterLink, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { flushQueue } from './retryQueue';
import FlowProgress from './components/FlowProgress';
import { track } from './metrics';
import Entry from './pages/Entry';
import VisitType from './pages/VisitType';
import QuestionnaireForm from './pages/QuestionnaireForm';
import Questions from './pages/Questions';
import Review from './pages/Review';
import Done from './pages/Done';
import AdminLogin from './pages/AdminLogin';
import AdminDashboard from './pages/AdminDashboard';
import AdminTemplates from './pages/AdminTemplates';
import AdminLlm from './pages/AdminLlm';
import LLMChat from './pages/LLMChat';

export default function App() {
  const location = useLocation();
  useEffect(() => {
    flushQueue();
  }, []);
  useEffect(() => {
    track('page_view', { path: location.pathname });
  }, [location.pathname]);

  const isChatPage = location.pathname === '/chat';
  const isAdminPage = location.pathname.startsWith('/admin');

  return (
    <Container
      maxW={isChatPage ? '100%' : 'container.md'}
      py={isChatPage ? 0 : 10}
      px={isChatPage ? 0 : 4}
      h={isChatPage ? '100vh' : 'auto'}
      display="flex"
      flexDirection="column"
    >
      {!isChatPage && (
        <Flex as="header" mb={4} align="center">
          <Heading size="lg">MonshinMate</Heading>
          <Spacer />
          {isAdminPage ? (
            <Button as={RouterLink} to="/" colorScheme="primary" variant="outline" size="sm">
              戻る
            </Button>
          ) : (
            <Button as={RouterLink} to="/admin" colorScheme="primary" size="sm">
              管理画面
            </Button>
          )}
        </Flex>
      )}

      <Box flex="1" overflowY="auto">
        {!isChatPage && <FlowProgress />}
        <Routes>
          <Route path="/" element={<Entry />} />
          <Route path="/visit-type" element={<VisitType />} />
          <Route path="/questionnaire" element={<QuestionnaireForm />} />
          <Route path="/questions" element={<Questions />} />
          <Route path="/review" element={<Review />} />
          <Route path="/done" element={<Done />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/templates" element={<AdminTemplates />} />
          <Route path="/admin/llm" element={<AdminLlm />} />
          <Route path="/chat" element={<LLMChat />} />
        </Routes>
      </Box>

      {!isChatPage && (
        <Box as="footer" mt={10} fontSize="sm" color="gray.600">
          本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。
        </Box>
      )}
    </Container>
  );
}
