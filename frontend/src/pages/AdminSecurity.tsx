import { useEffect, useState } from 'react';
import { Box, Heading, Text, VStack, HStack, Button, Image, Input, FormControl, FormLabel, useToast, Divider, Badge, Checkbox } from '@chakra-ui/react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';

interface AuthStatus {
  is_initial_password: boolean;
  is_totp_enabled: boolean;
  totp_mode?: 'off' | 'reset_only' | 'login_and_reset';
}

export default function AdminSecurity() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [currentMode, setCurrentMode] = useState<AuthStatus['totp_mode']>('off');
  const toast = useToast();
  const navigate = useNavigate();

  const loadStatus = async () => {
    try {
      const r = await fetch('/admin/auth/status');
      if (!r.ok) throw new Error();
      const d = await r.json();
      setStatus(d);
      setCurrentMode(d?.totp_mode ?? 'off');
    } catch {
      toast({ title: '状態の取得に失敗しました', status: 'error' });
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const startSetup = async () => {
    setLoading(true);
    setQrUrl(null);
    try {
      const r = await fetch('/admin/totp/setup');
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      setQrUrl(URL.createObjectURL(blob));
      toast({ title: 'Authenticator をスキャンしてください', status: 'info' });
    } catch {
      toast({ title: 'QRコードの生成に失敗しました', status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    if (!code) return;
    setLoading(true);
    try {
      const r = await fetch('/admin/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp_code: code }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || '認証に失敗しました');
      }
      toast({ title: '2要素認証を有効化しました', status: 'success' });
      setQrUrl(null);
      setCode('');
      loadStatus();
    } catch (e: any) {
      toast({ title: e.message, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const disableTotp = async () => {
    setLoading(true);
    try {
      const r = await fetch('/admin/totp/disable', { method: 'POST' });
      if (!r.ok) throw new Error();
      toast({ title: '2要素認証を無効化しました', status: 'success' });
      setQrUrl(null);
      setCode('');
      loadStatus();
    } catch {
      toast({ title: '無効化に失敗しました', status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const regenerate = async () => {
    setLoading(true);
    try {
      const r = await fetch('/admin/totp/regenerate', { method: 'POST' });
      if (!r.ok) throw new Error();
      toast({ title: '秘密鍵を再生成しました。新しいQRをスキャンしてください', status: 'info' });
      // すぐに新しいQRを取得
      await startSetup();
      loadStatus();
    } catch {
      toast({ title: '再生成に失敗しました', status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const setMode = async (mode: AuthStatus['totp_mode']) => {
    setModeSaving(true);
    try {
      const r = await fetch('/admin/totp/mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!r.ok) throw new Error();
      await loadStatus();
    } catch {
      toast({ title: '保存に失敗しました', status: 'error' });
    } finally {
      setModeSaving(false);
    }
  };

  return (
    <VStack align="stretch" spacing={6}>
      <Box>
        <Heading size="md">二段階認証（Authenticator）</Heading>
        <HStack mt={2}>
          <Text fontSize="sm">現在の状態:</Text>
          <Badge colorScheme={status?.is_totp_enabled ? 'green' : 'gray'}>
            {status?.is_totp_enabled ? '有効' : '無効'}
          </Badge>
        </HStack>
        <VStack mt={2} align="flex-start" spacing={1}>
          {(() => {
            const loginChecked = currentMode === 'login_and_reset';
            const onToggleLogin = async (checked: boolean) => {
              // ログインに使用: on → login_and_reset, off → reset_only（リセットは常に2FAを要求）
              await setMode(checked ? 'login_and_reset' : 'reset_only');
            };
            return (
              <>
                <HStack>
                  <Checkbox isChecked={loginChecked} isDisabled={modeSaving}
                    onChange={(e)=> onToggleLogin(e.target.checked)}>
                    ログインに使用
                  </Checkbox>
                </HStack>
                <Text fontSize="xs" color="gray.600">
                  ※パスワードリセットには二段階認証が必須です。。
                </Text>
              </>
            );
          })()}
        </VStack>

        <Text fontSize="xs" color="gray.600" mt={4}>
          Microsoft Authenticator や Google Authenticator などの認証アプリをご利用いただけます。
        </Text>

        {!status?.is_totp_enabled ? (
          <VStack align="stretch" spacing={3} mt={4}>
            <Text fontSize="sm">Authenticator アプリでQRをスキャンし、6桁コードを入力して有効化します。</Text>
            <HStack>
              <Button onClick={startSetup} isLoading={loading} colorScheme="primary">QRを表示</Button>
            </HStack>
            {qrUrl && (
              <VStack>
                <Image src={qrUrl} alt="TOTP QR" maxW="280px" w="100%" />
                <FormControl>
                  <FormLabel>6桁コード</FormLabel>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} maxW="200px" />
                </FormControl>
                <Button onClick={verify} isLoading={loading} colorScheme="primary">有効化</Button>
              </VStack>
            )}
          </VStack>
        ) : (
          <VStack align="stretch" spacing={3} mt={4}>
            <HStack>
              <Button variant="outline" onClick={disableTotp} isLoading={loading}>無効化</Button>
              <Button onClick={regenerate} isLoading={loading} colorScheme="primary">再設定（再生成）</Button>
            </HStack>
            <Text fontSize="xs" color="gray.600">再設定すると古いコードは無効になります。再度QRをスキャンしてください。</Text>
          </VStack>
        )}
      </Box>

      <Divider />

      <Box>
        <Heading size="md">パスワードの変更</Heading>
        <Text mt={2} fontSize="sm">セキュリティのため、パスワード変更は二段階認証による本人確認のうえで実施します。</Text>
        <HStack mt={3}>
          <Button as={RouterLink} to="/admin/password/reset" colorScheme="primary">パスワードをリセット</Button>
        </HStack>
      </Box>
    </VStack>
  );
}
