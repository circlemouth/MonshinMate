import { useState, useEffect } from 'react';
import { Box, Container, Heading, FormControl, FormLabel, Input, Button, Text, VStack, PinInput, PinInputField, HStack, Divider } from '@chakra-ui/react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNotify } from '../contexts/NotificationContext';
import { useDialog } from '../contexts/DialogContext';

export default function AdminPasswordReset() {
  const [step, setStep] = useState('request'); // 'request' | 'confirm'
  const [totpCode, setTotpCode] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const { checkAuthStatus, isTotpEnabled, emergencyResetAvailable, setShowTotpSetup } = useAuth();
  const { notify } = useNotify();
  const { confirm } = useDialog();

  useEffect(() => {
    // 認証状態の確認で全画面ローディングが発生すると本画面が再マウントされ
    // 無限ループになるため、ローディングを抑制した形で確認する
    checkAuthStatus(true);
  }, [checkAuthStatus]);

  // 非TOTP時の非常用リセットフォーム用 state
  const [emergencyPw, setEmergencyPw] = useState('');
  const [emNewPw, setEmNewPw] = useState('');
  const handleEmergencyReset = async () => {
    if (!emergencyPw || emNewPw.length < 8) {
      setError('非常用パスワードと新パスワード(8文字以上)を入力してください。');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/admin/password/reset/emergency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emergency_password: emergencyPw, new_password: emNewPw }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'パスワードの更新に失敗しました。');
      }
      notify({ title: 'パスワードがリセットされました。', status: 'success', channel: 'admin' });
      navigate('/admin/login');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isTotpEnabled && !emergencyResetAvailable) {
    return (
      <Container centerContent pt={10}>
        <VStack spacing={6} p={8} bg="white" borderRadius="md" boxShadow="lg" w="100%" maxW="md">
          <Heading size="lg">パスワードリセット</Heading>
          <Text fontSize="sm" color="gray.700">
            二段階認証（Authenticator）が無効で、非常用パスワードも未構成です。
            サーバ側で <code>ADMIN_EMERGENCY_RESET_PASSWORD</code> を設定できない場合は、管理者がサーバ上で次のスクリプトを実行してください。
          </Text>
          <Box w="100%" bg="gray.50" borderRadius="md" p={3} fontFamily="monospace" fontSize="sm">
            backend/tools/reset_admin_password.py
          </Box>
          <Text fontSize="xs" color="gray.600">
            実行後は、管理者パスワードが再設定されます。セキュリティのため、完了後に二段階認証の再有効化を推奨します。
          </Text>
          <Divider />
          {error && (<Text color="red.500" mt={2} fontSize="sm">{error}</Text>)}
          <Box mt={2}>
            <Button as={RouterLink} to="/admin/login" variant="link" size="sm">ログイン画面に戻る</Button>
          </Box>
        </VStack>
      </Container>
    );
  }

  if (!isTotpEnabled && emergencyResetAvailable) {
    return (
      <Container centerContent pt={10}>
        <VStack spacing={6} p={8} bg="white" borderRadius="md" boxShadow="lg" w="100%" maxW="md">
          <Heading size="lg">パスワードリセット</Heading>
          <Text fontSize="sm" color="gray.700">
            二段階認証（Authenticator）が無効のため、非常用パスワードでのリセットします。
            サーバの環境変数 <code>ADMIN_EMERGENCY_RESET_PASSWORD</code> に設定された値を入力してください。
          </Text>
          <Divider />
          <FormControl isInvalid={!!error}>
            <FormLabel>非常用リセットパスワード</FormLabel>
            <Input type="password" value={emergencyPw} onChange={(e)=>setEmergencyPw(e.target.value)} />
            <Text fontSize="xs" color="gray.600" mt={1}>
              非常用リセットパスワードはサーバの環境変数 <code>ADMIN_EMERGENCY_RESET_PASSWORD</code> で設定されています。
            </Text>
          </FormControl>
          <FormControl isInvalid={!!error}>
            <FormLabel>新しいパスワード</FormLabel>
            <Input type="password" value={emNewPw} onChange={(e)=>setEmNewPw(e.target.value)} />
          </FormControl>
          <Button colorScheme="primary" onClick={handleEmergencyReset} isLoading={isLoading} width="100%">
            非常用パスワードでリセット
          </Button>
          {error && (<Text color="red.500" mt={2} fontSize="sm">{error}</Text>)}
          <Box mt={2}>
            <Button as={RouterLink} to="/admin/login" variant="link" size="sm">ログイン画面に戻る</Button>
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
      notify({
        title: 'パスワードがリセットされました。',
        status: 'success',
        channel: 'admin',
      });
      await checkAuthStatus(true);
      if (!isTotpEnabled) {
        const enableTotp = await confirm({
          title: 'Authenticator を有効にしますか？',
          description: '有効にしないとパスワードのリセットができません。',
          confirmText: '有効にする',
          cancelText: 'あとで',
        });
        if (enableTotp) {
          setShowTotpSetup(true);
        } else {
          notify({
            title: 'Authenticator を後から設定できますが、未設定のままではパスワードのリセットはできません。',
            status: 'warning',
            channel: 'admin',
            duration: 7000,
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
