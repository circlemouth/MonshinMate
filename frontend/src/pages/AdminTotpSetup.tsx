import { useState, useEffect } from 'react';
import { Box, Container, Heading, Text, VStack, Image, Input, Button, useToast, Spinner, FormControl, FormLabel, Checkbox } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AdminTotpSetup() {
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [isLoading, setIsLoading] = useState(false); // QRコード取得中のローディング
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState('');
  const { checkAuthStatus, setShowTotpSetup } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [isQrCodeVisible, setIsQrCodeVisible] = useState(false);
  const [useForLogin, setUseForLogin] = useState(true); // デフォルトでチェックを入れておく

  const handleEnableTotp = async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch('/admin/totp/setup');
      if (!response.ok) {
        throw new Error('QRコードの取得に失敗しました。');
      }
      const imageBlob = await response.blob();
      setQrCodeUrl(URL.createObjectURL(imageBlob));
      setIsQrCodeVisible(true); // QRコードなどを表示
    } catch (e: any) {
      setError(e.message || 'エラーが発生しました。');
    } finally {
      setIsLoading(false);
    }
  };

  // 画面表示と同時にQRの取得を開始して、すぐにコード入力まで進められるようにする
  // （セキュリティタブからの起動要件に対応）
  useEffect(() => {
    if (!isQrCodeVisible && !qrCodeUrl) {
      handleEnableTotp();
    }
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
        // useForLogin の状態も送信する（バックエンドの対応が必要）
        body: JSON.stringify({ totp_code: totpCode, use_for_login: useForLogin }),
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
      await checkAuthStatus(true);
      setShowTotpSetup(false);
      navigate('/admin/login');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSkip = async () => {
    await checkAuthStatus(true);
    setShowTotpSetup(false);
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
          
          {!isQrCodeVisible ? (
            <>
              <Text textAlign="center">セキュリティ強化のため、2要素認証の設定を強く推奨します。</Text>
              <Button 
                colorScheme="primary" 
                onClick={handleEnableTotp} 
                isLoading={isLoading}
                width="100%"
              >
                2要素認証を有効にする
              </Button>
              {error && <Text color="red.500" fontSize="sm">{error}</Text>}
            </>
          ) : (
            <>
              <Text textAlign="center">認証アプリ（Google Authenticatorなど）で以下のQRコードをスキャンしてください。</Text>
              {isLoading && <Spinner size="xl" />}
              {error && !qrCodeUrl && <Text color="red.500">{error}</Text>}
              {qrCodeUrl && <Image src={qrCodeUrl} alt="TOTP QR Code" maxW="280px" w="100%" />}

              <Text fontSize="sm">QRコードをスキャンした後、アプリに表示される6桁のコードを入力して設定を完了してください。</Text>
              
              <Checkbox 
                isChecked={useForLogin} 
                onChange={(e) => setUseForLogin(e.target.checked)}
                width="100%"
              >
                <Text fontSize="sm">今後、管理画面へのログインに2要素認証を使用する</Text>
              </Checkbox>

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
              </VStack>
            </>
          )}

          <Button 
            variant="link"
            onClick={handleSkip}
            isDisabled={isVerifying || isLoading}
            size="sm"
            mt={2}
          >
            後で設定する
          </Button>
        </VStack>
      </Container>
    </Box>
  );
}
