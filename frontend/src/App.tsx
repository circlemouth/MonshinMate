import { Container, Heading, Box } from '@chakra-ui/react';
import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import QuestionnaireForm from './pages/QuestionnaireForm';
import Admin from './pages/Admin';
import LLMChat from './pages/LLMChat';

export default function App() {
  return (
    <Container maxW="container.md" py={10}>
      <Heading mb={4}>MonshinMate</Heading>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/form" element={<QuestionnaireForm />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/chat" element={<LLMChat />} />
      </Routes>
      <Box as="footer" mt={10} fontSize="sm" color="gray.500">
        本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。
      </Box>
    </Container>
  );
}
