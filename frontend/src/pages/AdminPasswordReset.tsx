import { useState, useEffect } from 'react';
import { Box, Container, Heading, FormControl, FormLabel, Input, Button, Text, VStack, useToast, PinInput, PinInputField, HStack } from '@chakra-ui/react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AdminPasswordReset() {
  const [step, setStep] = useState('request'); // 'request' | 'confirm'
  const [totpCode, setTotpCode] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const { checkAuthStatus, isTotpEnabled, setShowTotpSetup } = useAuth();

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  if (!isTotpEnabled) {
    return (
      <Container centerContent pt={10}>
        <VStack spacing={6} p={8} bg="white" borderRadius="md" boxShadow="lg" w="100%" maxW="md">
          <Heading size="lg">パスワードリセット</Heading>
          <Text>
            Authenticator を有効にしていないためパスワードリセットは行えません。パスワードを忘れた場合はシステムの初期化が必要です。
            <br />
            <code>backend/tools/reset_admin_password.py</code> を実行してください。
          </Text>
          <Box mt={4}>
            <Button as={RouterLink} to="/admin/login" variant="link" size="sm">
              ログイン画面に戻る
            </Button>
          </Box>
        </VStack>
      </Container>
    );
  }

  const handleRequestReset = async () => {
    if (totpCode.length !== 6) {
      setError('6桁のコードを入力してください。');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/admin/password/reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp_code: totpCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'リクエストに失敗しました。');
      }
      setToken(data.reset_token);
      setStep('confirm');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmReset = async () => {
    if (newPassword.length < 8) {
      setError('新しいパスワードは8文字以上で設定してください。');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/admin/password/reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'パスワードの更新に失敗しました。');
      }
      toast({
        title: 'パスワードがリセットされました。',
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
      await checkAuthStatus();
      if (!isTotpEnabled) {
        const enableTotp = window.confirm(
          'Authenticator を有効にしますか？\n有効にしないとパスワードのリセットができません。'
        );
        if (enableTotp) {
          setShowTotpSetup(true);
        } else {
          toast({
            title: 'Authenticator を後から設定できますが、未設定のままではパスワードのリセットはできません。',
            status: 'warning',
            duration: 7000,
            isClosable: true,
          });
          navigate('/admin/login');
        }
      } else {
        navigate('/admin/login');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Container centerContent pt={10}>
      <VStack spacing={6} p={8} bg="white" borderRadius="md" boxShadow="lg" w="100%" maxW="md">
        <Heading size="lg">パスワードリセット</Heading>
        
        {step === 'request' && (
          <>
            <Text>2要素認証アプリに表示されるコードを入力してください。</Text>
            <FormControl isInvalid={!!error}>
              <FormLabel>確認コード</FormLabel>
              <HStack>
                <PinInput value={totpCode} onChange={setTotpCode} otp>
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                </PinInput>
              </HStack>
            </FormControl>
            <Button colorScheme="primary" onClick={handleRequestReset} isLoading={isLoading} width="100%">
              本人確認
            </Button>
          </>
        )}

        {step === 'confirm' && (
          <>
            <Text>新しいパスワードを設定してください。</Text>
            <FormControl isInvalid={!!error}>
              <FormLabel>新しいパスワード</FormLabel>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
              />
            </FormControl>
            <Button colorScheme="primary" onClick={handleConfirmReset} isLoading={isLoading} width="100%">
              パスワードを更新
            </Button>
          </>
        )}

        {error && (
          <Text color="red.500" mt={2} fontSize="sm">{error}</Text>
        )}

        <Box mt={4}>
          <Button as={RouterLink} to="/admin/login" variant="link" size="sm">
            ログイン画面に戻る
          </Button>
        </Box>
      </VStack>
    </Container>
  );
}
