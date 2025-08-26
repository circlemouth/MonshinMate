import { useEffect, useState } from 'react';
import { Box, Heading, Text, VStack, HStack, Button, Image, Input, FormControl, FormLabel, useToast, Divider, Badge, Checkbox, useDisclosure, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Spinner } from '@chakra-ui/react';
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
  // 画面内モーダルで TOTP セットアップを行う
  const toast = useToast();
  const navigate = useNavigate();
  const { isOpen, onOpen, onClose } = useDisclosure();
  // 無効化確認用モーダル
  const disableModal = useDisclosure();
  const [disableCode, setDisableCode] = useState('');

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

  const verify = async (): Promise<boolean> => {
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
      return true;
    } catch (e: any) {
      toast({ title: e.message, status: 'error' });
      return false;
    } finally {
      setLoading(false);
    }
  };

  const disableTotp = async () => {
    if (!disableCode) return;
    setLoading(true);
    try {
      const r = await fetch('/admin/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp_code: disableCode }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || '無効化に失敗しました');
      }
      toast({ title: '2要素認証を無効化しました', status: 'success' });
      setQrUrl(null);
      setCode('');
      setDisableCode('');
      loadStatus();
      disableModal.onClose();
    } catch (e: any) {
      toast({ title: e.message, status: 'error' });
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
        {status?.is_totp_enabled && (
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
                    ※パスワードリセットには二段階認証が必須です。
                  </Text>
                </>
              );
            })()}
          </VStack>
        )}

        <Text fontSize="xs" color="gray.600" mt={4}>
          Microsoft Authenticator や Google Authenticator などの認証アプリをご利用いただけます。
        </Text>

        {!status?.is_totp_enabled ? (
          <VStack align="stretch" spacing={3} mt={4}>
            <Button
              colorScheme="primary"
              onClick={async () => { setQrUrl(null); setCode(''); onOpen(); await startSetup(); }}
              alignSelf="flex-start"
            >
              二段階認証を有効化する
            </Button>
            <Text fontSize="sm" color="gray.700">
              パスワードをリセットするには二段階認証の有効化が必要です。セキュリティ強化のため有効化を推奨します。
            </Text>
          </VStack>
        ) : (
          <VStack align="stretch" spacing={3} mt={4}>
            <HStack>
              <Button colorScheme="primary" onClick={disableModal.onOpen} isLoading={loading}>
                二段階認証を無効化する
              </Button>
            </HStack>
          </VStack>
        )}
      </Box>

      <Divider />

      {status?.is_totp_enabled && (
        <Box>
          <Heading size="md">パスワードの変更</Heading>
          <Text mt={2} fontSize="sm">セキュリティのため、パスワード変更は二段階認証による本人確認のうえで実施します。</Text>
          <HStack mt={3}>
            <Button as={RouterLink} to="/admin/password/reset" colorScheme="primary">パスワードをリセット</Button>
          </HStack>
        </Box>
      )}

      {/* 二段階認証の設定用モーダル */}
      <Modal isOpen={isOpen} onClose={() => { onClose(); setQrUrl(null); setCode(''); }} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>二段階認証の設定</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack align="stretch" spacing={3}>
              <Text fontSize="sm">認証アプリ（Google/Microsoft Authenticator など）で以下のQRコードをスキャンしてください。</Text>
              {!qrUrl ? (
                <HStack>
                  <Spinner size="sm" />
                  <Text fontSize="sm">QRコードを生成中...</Text>
                </HStack>
              ) : (
                <Image src={qrUrl} alt="TOTP QR" maxW="280px" w="100%" alignSelf="center" />
              )}
              <FormControl>
                <FormLabel>6桁コード</FormLabel>
                <Input value={code} onChange={(e) => setCode(e.target.value)} maxW="200px" />
              </FormControl>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <HStack>
              <Button variant="ghost" onClick={() => { onClose(); setQrUrl(null); setCode(''); }}>閉じる</Button>
              <Button colorScheme="primary" isLoading={loading}
                isDisabled={!qrUrl || !code || code.length !== 6}
                onClick={async () => {
                  const ok = await verify();
                  if (ok) onClose();
                }}
              >
                有効化を確定
              </Button>
            </HStack>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 二段階認証の無効化確認モーダル */}
      <Modal isOpen={disableModal.isOpen} onClose={() => { disableModal.onClose(); setDisableCode(''); }} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>二段階認証の無効化</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack align="stretch" spacing={3}>
              <Text fontSize="sm">Authenticatorに表示されている6桁のコードを入力してください。</Text>
              <FormControl>
                <FormLabel>6桁コード</FormLabel>
                <Input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} maxW="200px" />
              </FormControl>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <HStack>
              <Button variant="ghost" onClick={() => { disableModal.onClose(); setDisableCode(''); }}>キャンセル</Button>
              <Button colorScheme="red" isLoading={loading}
                isDisabled={!disableCode || disableCode.length !== 6}
                onClick={disableTotp}
              >
                無効化する
              </Button>
            </HStack>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </VStack>
  );
}
