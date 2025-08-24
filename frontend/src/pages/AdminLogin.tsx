import { useState } from 'react';
import {
  Container,
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  Text,
  HStack,
  Heading,
} from '@chakra-ui/react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AdminLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const navigate = useNavigate();
  const { checkAuthStatus, isTotpEnabled } = useAuth();

  const handleLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || 'ログインに失敗しました');
      }
      
      if (data?.status === 'totp_required') {
        setTotpRequired(true);
        return;
      }
      
      sessionStorage.setItem('adminLoggedIn', '1');
      await checkAuthStatus(); // AuthContextの状態を更新
      navigate('/admin/templates');

    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTotpLogin = async () => {
    if (!totpCode) {
      setError('TOTPコードを入力してください');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/admin/login/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp_code: totpCode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || 'TOTPコードが正しくありません');
      }
      sessionStorage.setItem('adminLoggedIn', '1');
      await checkAuthStatus(); // AuthContextの状態を更新
      navigate('/admin/templates');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container centerContent pt={10}>
      <VStack spacing={6} p={8} bg="white" borderRadius="md" boxShadow="lg" w="100%" maxW="md">
        <Heading size="lg">管理者ログイン</Heading>

        {!totpRequired ? (
          <>
            <FormControl isInvalid={!!error}>
              <FormLabel>パスワード</FormLabel>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleLogin(); }
                }}
                autoFocus
              />
            </FormControl>
            <HStack justify="space-between" width="100%">
              {isTotpEnabled ? (
                <Button as={RouterLink} to="/admin/password/reset" variant="link" size="sm">
                  パスワードをお忘れですか？
                </Button>
              ) : (
                <Text fontSize="xs" color="gray.600">
                  パスワードを忘れた場合は 所定のリセットコードをコマンドラインからを実行してください。
                </Text>
              )}
              <Button onClick={handleLogin} colorScheme="primary" isLoading={loading}>
                ログイン
              </Button>
            </HStack>
          </>
        ) : (
          <>
            <Text>2段階認証コードを入力してください。</Text>
            <FormControl isInvalid={!!error}>
              <FormLabel>確認コード</FormLabel>
              <Input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456"
                maxLength={6}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleTotpLogin(); }
                }}
              />
            </FormControl>
            <HStack justify="space-between" width="100%">
              <Button variant="link" onClick={() => setTotpRequired(false)} isDisabled={loading} size="sm">
                戻る
              </Button>
              <Button colorScheme="primary" onClick={handleTotpLogin} isLoading={loading}>
                認証してログイン
              </Button>
            </HStack>
          </>
        )}
        {error && (
          <VStack spacing={1}>
            <Text color="red.500" mt={2} fontSize="sm" textAlign="center">{error}</Text>
            {isTotpEnabled ? (
              <Text fontSize="xs" color="gray.600">
                パスワードをお忘れの場合は二段階認証によるリセットへ進んでください：
                <Button as={RouterLink} to="/admin/password/reset" variant="link" size="xs" colorScheme="primary">パスワードをリセット</Button>
              </Text>
            ) : (
              <Text fontSize="xs" color="gray.600">
                パスワードを忘れた場合は 所定のリセットコードをコマンドラインからを実行してください。
              </Text>
            )}
          </VStack>
        )}
      </VStack>
    </Container>
  );
}
