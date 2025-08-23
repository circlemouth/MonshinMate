import { useState, useEffect } from 'react';
import { Box, Container, Heading, Text, VStack, Image, Input, Button, useToast, Spinner, HStack, FormControl, FormLabel } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AdminTotpSetup() {
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState('');
  const { checkAuthStatus, setShowTotpSetup } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchQrCode = async () => {
      setIsLoading(true);
      try {
        const response = await fetch('/admin/totp/setup');
        if (!response.ok) {
          throw new Error('QRコードの取得に失敗しました。');
        }
        const imageBlob = await response.blob();
        setQrCodeUrl(URL.createObjectURL(imageBlob));
      } catch (e: any) {
        setError(e.message || 'エラーが発生しました。');
      } finally {
        setIsLoading(false);
      }
    };
    fetchQrCode();
  }, []);

  const handleVerify = async () => {
    if (!totpCode || totpCode.length !== 6) {
      setError('6桁のコードを入力してください。');
      return;
    }
    setIsVerifying(true);
    setError('');
    try {
      const res = await fetch('/admin/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp_code: totpCode }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'コードの検証に失敗しました。');
      }

      toast({
        title: '2要素認証が有効になりました。',
        status: 'success',
        duration: 3000,
        isClosable: true,
      });
      await checkAuthStatus(); // 状態を更新してこの画面を閉じる
      setShowTotpSetup(false);
      // 初期設定ウィザードの次の導線として管理ログインへ誘導
      navigate('/admin/login');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSkip = async () => {
    // 何もせずに認証状態をチェックして画面を閉じるだけ
    // isTotpEnabled が false のままなので、次回以降も設定が促される（ようにできる）
    await checkAuthStatus();
    setShowTotpSetup(false);
    // セットアップを後回しにする場合も管理ログインへ誘導
    navigate('/admin/login');
     toast({
        title: '2要素認証の設定はいつでも管理画面から行えます。',
        status: 'info',
        duration: 5000,
        isClosable: true,
      });
  }

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
        <VStack spacing={5} p={6} bg="white" borderRadius="md" boxShadow="lg" w="100%" maxW="md">
          <Heading size="lg">2要素認証の設定</Heading>
          <Text textAlign="center">セキュリティ強化のため、2要素認証の設定を強く推奨します。認証アプリ（Google Authenticatorなど）で以下のQRコードをスキャンしてください。</Text>
          
          {isLoading && <Spinner size="xl" />}
          {error && !qrCodeUrl && <Text color="red.500">{error}</Text>}
          {qrCodeUrl && <Image src={qrCodeUrl} alt="TOTP QR Code" maxW="280px" w="100%" />}

          <Text fontSize="sm">QRコードをスキャンした後、アプリに表示される6桁のコードを入力して設定を完了してください。</Text>

          <FormControl isInvalid={!!error && totpCode.length > 0}>
            <FormLabel>確認コード</FormLabel>
            <Input
              type="text"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.trim())}
              placeholder="123456"
              maxLength={6}
              textAlign="center"
              letterSpacing="widest"
              fontSize="xl"
            />
          </FormControl>
          {error && <Text color="red.500" fontSize="sm">{error}</Text>}

          <VStack width="100%" pb={2}>
            <Button 
              colorScheme="primary" 
              onClick={handleVerify} 
              isLoading={isVerifying}
              isDisabled={isLoading || !qrCodeUrl}
              width="100%"
            >
              設定を完了する
            </Button>
            <Button 
              variant="link"
              onClick={handleSkip}
              isDisabled={isVerifying}
              size="sm"
              mt={2}
            >
              後で設定する
            </Button>
          </VStack>
        </VStack>
      </Container>
    </Box>
  );
}
