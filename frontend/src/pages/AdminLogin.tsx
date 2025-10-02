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
  Box,
} from '@chakra-ui/react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
type Props = {
  inModal?: boolean;
  onSuccess?: () => void;
};

export default function AdminLogin({ inModal = false, onSuccess }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const navigate = useNavigate();
  const { checkAuthStatus, isTotpEnabled, emergencyResetAvailable } = useAuth();

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
      setFailedAttempts(0);
      await checkAuthStatus(true); // AuthContextの状態を更新
      onSuccess?.();
      navigate('/admin/main', { replace: true });

    } catch (e: any) {
      setError(e.message);
      setFailedAttempts((n) => n + 1);
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
      await checkAuthStatus(true); // AuthContextの状態を更新
      onSuccess?.();
      navigate('/admin/main', { replace: true });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const content = (
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
              <Box />
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
          <>
            <Text color="red.500" mt={2} fontSize="sm" textAlign="center">{error}</Text>
            {failedAttempts >= 3 && (
              <>
                {isTotpEnabled && (
                  <Button as={RouterLink} to="/admin/password/reset" variant="link" size="sm" display="block" mx="auto">
                    パスワードをお忘れですか？
                  </Button>
                )}
                {!isTotpEnabled && emergencyResetAvailable && (
                  <Button as={RouterLink} to="/admin/password/reset" variant="link" size="sm" display="block" mx="auto">
                    非常用パスワードでリセット
                  </Button>
                )}
                {!isTotpEnabled && !emergencyResetAvailable && error.includes('パスワードが間違っています') && (
                  <Text fontSize="xs" color="gray.600" textAlign="center" width="100%" mt={2}>
                    リセットには二段階認証の有効化、またはサーバ上で
                    <code> backend/tools/reset_admin_password.py </code>
                    の実行が必要です。
                  </Text>
                )}
              </>
            )}
          </>
        )}
      </VStack>
  );

  if (inModal) {
    return content;
  }

  return (
    <Container centerContent pt={10}>
      {content}
    </Container>
  );
}
