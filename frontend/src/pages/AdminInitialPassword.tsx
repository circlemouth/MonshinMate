import { useEffect, useState } from 'react';
import { Box, Container, Heading, FormControl, FormLabel, Input, Button, Text, VStack, useToast } from '@chakra-ui/react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function AdminInitialPassword() {
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { checkAuthStatus, setShowTotpSetup, isInitialPassword } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  // 初期パスワードでない場合はこのページを使わせない（セキュリティ保護）
  useEffect(() => {
    if (isInitialPassword === false) {
      navigate('/admin/login');
    }
  }, [isInitialPassword]);

  const handleSetPassword = async () => {
    if (!newPassword || !newPasswordConfirm) {
      setError('パスワードを入力してください');
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setError('確認用パスワードが一致しません');
      return;
    }
    if (newPassword.length < 8) {
      setError('パスワードは8文字以上で設定してください');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const res = await fetch('/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.detail || 'パスワードの設定に失敗しました。');
        return;
      }

      toast({
        title: 'パスワードが設定されました。',
        description: '続けて2要素認証の設定を行ってください。',
        status: 'success',
        duration: 5000,
        isClosable: true,
      });

      // 認証状態を更新して、次のステップ（TOTP設定）へ進ませる
      await checkAuthStatus();
      setShowTotpSetup(true);

    } catch (e) {
      setError('エラーが発生しました。ネットワーク接続を確認してください。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box
      position="fixed"
      top={0}
      left={0}
      right={0}
      bottom={0}
      bg="gray.100"
      zIndex={2000}
      overflowY="auto"
    >
      <Container centerContent py={10} px={4} minH="100vh">
        <VStack spacing={6} p={6} bg="white" borderRadius="md" boxShadow="lg" w="100%" maxW="md">
          <Heading size="lg">初回パスワード設定</Heading>
          <Text>セキュリティのため、最初に管理用パスワードを設定してください。</Text>
          <FormControl isInvalid={!!error}>
            <FormLabel>新しいパスワード</FormLabel>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="8文字以上"
              autoFocus
            />
          </FormControl>
          <FormControl isInvalid={!!error}>
            <FormLabel>新しいパスワード（確認用）</FormLabel>
            <Input
              type="password"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
            />
          </FormControl>
          {error && (
            <Text color="red.500" mt={2} fontSize="sm">{error}</Text>
          )}
          <Button 
            colorScheme="primary" 
            onClick={handleSetPassword} 
            isLoading={isLoading}
            width="100%"
          >
            パスワードを設定
          </Button>
        </VStack>
      </Container>
    </Box>
  );
}
