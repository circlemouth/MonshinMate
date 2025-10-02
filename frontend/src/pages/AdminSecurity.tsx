import { useEffect, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Button,
  ButtonGroup,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Image,
  Input,
  ListItem,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  OrderedList,
  PinInput,
  PinInputField,
  SimpleGrid,
  Spinner,
  Stack,
  Switch,
  Text,
  useDisclosure,
  VStack,
} from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router-dom';
import { useNotify } from '../contexts/NotificationContext';
import StatusBanner from '../components/StatusBanner';

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
  const { notify } = useNotify();
  const { isOpen, onOpen, onClose } = useDisclosure();
  // 無効化確認用モーダル
  const disableModal = useDisclosure();
  const [disableCode, setDisableCode] = useState('');
  // パスワード変更用モーダル
  const pwModal = useDisclosure();
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwLoading, setPwLoading] = useState(false);

  const loadStatus = async () => {
    try {
      const r = await fetch('/admin/auth/status');
      if (!r.ok) throw new Error();
      const d = await r.json();
      setStatus(d);
      setCurrentMode(d?.totp_mode ?? 'off');
    } catch {
      notify({ title: '状態の取得に失敗しました', status: 'error', channel: 'admin' });
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
      notify({ title: 'Authenticator をスキャンしてください', status: 'info', channel: 'admin' });
    } catch {
      notify({ title: 'QRコードの生成に失敗しました', status: 'error', channel: 'admin' });
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
      notify({ title: '2要素認証を有効化しました', status: 'success', channel: 'admin' });
      setQrUrl(null);
      setCode('');
      loadStatus();
      return true;
    } catch (e: any) {
      notify({ title: e.message, status: 'error', channel: 'admin' });
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
      notify({ title: '2要素認証を無効化しました', status: 'success', channel: 'admin' });
      setQrUrl(null);
      setCode('');
      setDisableCode('');
      loadStatus();
      disableModal.onClose();
    } catch (e: any) {
      notify({ title: e.message, status: 'error', channel: 'admin' });
    } finally {
      setLoading(false);
    }
  };

  const regenerate = async () => {
    setLoading(true);
    try {
      const r = await fetch('/admin/totp/regenerate', { method: 'POST' });
      if (!r.ok) throw new Error();
      notify({
        title: '秘密鍵を再生成しました。新しいQRをスキャンしてください',
        status: 'info',
        channel: 'admin',
      });
      // すぐに新しいQRを取得
      await startSetup();
      loadStatus();
    } catch {
      notify({ title: '再生成に失敗しました', status: 'error', channel: 'admin' });
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
      notify({ title: '保存に失敗しました', status: 'error', channel: 'admin' });
    } finally {
      setModeSaving(false);
    }
  };

  const changePassword = async () => {
    if (!currentPw || !newPw || newPw !== newPw2) {
      notify({ title: '入力内容を確認してください', status: 'error', channel: 'admin' });
      return;
    }
    setPwLoading(true);
    try {
      const r = await fetch('/admin/password/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || '変更に失敗しました');
      }
      notify({
        title: 'パスワードを変更しました。二段階認証は無効化されました',
        status: 'success',
        channel: 'admin',
      });
      setCurrentPw('');
      setNewPw('');
      setNewPw2('');
      pwModal.onClose();
      await loadStatus();
    } catch (e: any) {
      notify({ title: e.message, status: 'error', channel: 'admin' });
    } finally {
      setPwLoading(false);
    }
  };

  const totpEnabled = !!status?.is_totp_enabled;

  return (
    <Stack spacing={6} align="stretch">
      <SimpleGrid columns={{ base: 1, lg: 2 }} spacing={6} alignItems="stretch">
        <Card variant="outline" h="100%">
          <CardHeader>
            <Stack spacing={2} align="flex-start">
              <HStack spacing={3} align="center">
                <Heading size="md">多要素認証（Authenticator）</Heading>
                <Badge colorScheme={totpEnabled ? 'green' : 'gray'}>{totpEnabled ? '有効' : '無効'}</Badge>
              </HStack>
              <Text fontSize="sm" color="gray.600">
                管理者アカウントを認証アプリのワンタイムコードで保護します。
              </Text>
            </Stack>
          </CardHeader>
          <CardBody>
            {!status ? (
              <Stack direction="row" spacing={3} align="center">
                <Spinner size="sm" />
                <Text fontSize="sm">状態を取得しています...</Text>
              </Stack>
            ) : totpEnabled ? (
              <Stack spacing={5} align="flex-start">
                <StatusBanner
                  status="success"
                  description="二段階認証は有効です。Authenticator アプリで生成された 6 桁コードを使用してください。"
                />
                <FormControl display="flex" alignItems="center" flexWrap="wrap" gap={3}>
                  <Switch
                    isChecked={currentMode === 'login_and_reset'}
                    onChange={(e) => setMode(e.target.checked ? 'login_and_reset' : 'reset_only')}
                    isDisabled={modeSaving}
                  />
                  <Stack spacing={0}>
                    <Text fontSize="sm" fontWeight="medium">ログイン時にもコードを要求</Text>
                    <FormHelperText fontSize="xs" color="gray.500">
                      {modeSaving ? '保存中...' : 'パスワードリセットでは常に二段階認証が必要です。'}
                    </FormHelperText>
                  </Stack>
                </FormControl>
                <Stack spacing={3} align="flex-start" w="100%">
                  <ButtonGroup size="sm" spacing={3}>
                    <Button
                      variant="outline"
                      colorScheme="primary"
                      onClick={async () => {
                        await regenerate();
                      }}
                      isLoading={loading}
                    >
                      秘密鍵を再生成
                    </Button>
                    <Button colorScheme="red" onClick={disableModal.onOpen} isLoading={loading}>
                      二段階認証を無効化
                    </Button>
                  </ButtonGroup>
                  <Text fontSize="xs" color="gray.500">
                    ※ 秘密鍵を再生成すると、すべての端末で再登録が必要になります。
                  </Text>
                </Stack>
              </Stack>
            ) : (
              <Stack spacing={5} align="flex-start">
                <StatusBanner
                  status="warning"
                  description="二段階認証が無効です。セキュリティ強化のため有効化を推奨します。"
                />
                <OrderedList spacing={2} pl={4} fontSize="sm" color="gray.700">
                  <ListItem>Authenticator などの認証アプリを準備する</ListItem>
                  <ListItem>下の「設定を開始」から QR コードを取得する</ListItem>
                  <ListItem>アプリで登録し、生成された 6 桁コードを入力する</ListItem>
                </OrderedList>
                <Stack spacing={2} align="flex-start">
                  <Button
                    colorScheme="primary"
                    onClick={async () => {
                      setQrUrl(null);
                      setCode('');
                      onOpen();
                      await startSetup();
                    }}
                    isLoading={loading && isOpen}
                  >
                    設定を開始
                  </Button>
                  <Text fontSize="xs" color="gray.500">
                    Microsoft Authenticator や Google Authenticator などが利用できます。
                  </Text>
                </Stack>
              </Stack>
            )}
          </CardBody>
          <CardFooter>
            <Text fontSize="xs" color="gray.500">
              二段階認証を有効にすると、認証アプリを紛失した場合でも非常用パスワードで復旧できます。
            </Text>
          </CardFooter>
        </Card>

        <Card variant="outline" h="100%">
          <CardHeader>
            <Heading size="md">パスワード管理</Heading>
          </CardHeader>
          <CardBody>
            <Stack spacing={4} align="flex-start">
              <Text fontSize="sm" color="gray.700">
                現在のパスワードを更新すると、セキュリティを保ったままアカウントを運用できます。パスワード変更時には二段階認証が一時的に無効化されます。
              </Text>
              <StatusBanner
                status="info"
                description="強固なパスワード（12文字以上・記号を含む）を設定し、定期的に更新してください。"
              />
            </Stack>
          </CardBody>
          <CardFooter>
            <Stack direction={{ base: 'column', sm: 'row' }} spacing={3} align={{ base: 'stretch', sm: 'center' }} w="100%">
              <Button colorScheme="primary" onClick={pwModal.onOpen} w={{ base: '100%', sm: 'auto' }}>
                パスワードを変更
              </Button>
              <Button
                as={RouterLink}
                to="/admin/password/reset"
                variant="outline"
                colorScheme="primary"
                w={{ base: '100%', sm: 'auto' }}
              >
                非常用リセットへ
              </Button>
            </Stack>
          </CardFooter>
        </Card>
      </SimpleGrid>

      <Card variant="outline">
        <CardHeader>
          <Heading size="sm">非常時の運用ガイド</Heading>
        </CardHeader>
        <CardBody>
          <Stack spacing={4} fontSize="sm" color="gray.700">
            <Text>
              管理者がログインできなくなった場合の復旧手順を必ず共有してください。組織の運用ルールに沿って定期的に見直すことを推奨します。
            </Text>
            <OrderedList spacing={2} pl={4}>
              <ListItem>
                サーバ環境変数 <code>ADMIN_EMERGENCY_RESET_PASSWORD</code> を設定しておくと、管理画面の
                <RouterLink to="/admin/password/reset">非常用リセット</RouterLink> から復旧できます。
              </ListItem>
              <ListItem>
                環境変数が未設定の場合は、サーバ上で <code>backend/tools/reset_admin_password.py</code> を実行してください。
              </ListItem>
            </OrderedList>
            <Text fontSize="xs" color="gray.500">
              非常用パスワードは安全な場所に限定配布し、復旧後は速やかに無効化してください。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Modal
        isOpen={pwModal.isOpen}
        onClose={() => {
          pwModal.onClose();
          setCurrentPw('');
          setNewPw('');
          setNewPw2('');
        }}
        isCentered
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>パスワードの変更</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Stack spacing={4}>
              <StatusBanner
                status="info"
                description="変更後は新しいパスワードで直ちにログインできます。二段階認証は再設定が必要になります。"
                variant="left-accent"
              />
              <FormControl>
                <FormLabel>現在のパスワード</FormLabel>
                <Input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
              </FormControl>
              <FormControl>
                <FormLabel>新しいパスワード</FormLabel>
                <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              </FormControl>
              <FormControl>
                <FormLabel>新しいパスワード（確認）</FormLabel>
                <Input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
              </FormControl>
            </Stack>
          </ModalBody>
          <ModalFooter>
            <ButtonGroup spacing={3}>
              <Button
                variant="ghost"
                onClick={() => {
                  pwModal.onClose();
                  setCurrentPw('');
                  setNewPw('');
                  setNewPw2('');
                }}
              >
                キャンセル
              </Button>
              <Button
                colorScheme="primary"
                isLoading={pwLoading}
                onClick={changePassword}
                isDisabled={!currentPw || !newPw || newPw !== newPw2}
              >
                変更する
              </Button>
            </ButtonGroup>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isOpen}
        onClose={() => {
          onClose();
          setQrUrl(null);
          setCode('');
        }}
        isCentered
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>二段階認証の設定</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Stack spacing={4} align="center">
              <StatusBanner
                status="info"
                description="認証アプリで QR をスキャン後、6 桁コードを入力して有効化を完了してください。"
                variant="left-accent"
                w="100%"
              />
              {!qrUrl ? (
                <Stack direction="row" spacing={3} align="center">
                  <Spinner size="sm" />
                  <Text fontSize="sm">QRコードを生成中...</Text>
                </Stack>
              ) : (
                <Image src={qrUrl} alt="TOTP QR" maxW="260px" w="100%" borderRadius="md" shadow="md" />
              )}
              <FormControl textAlign="center">
                <FormLabel>6桁コード</FormLabel>
                <PinInput
                  otp
                  value={code}
                  onChange={(value) => setCode(value)}
                  isDisabled={!qrUrl}
                  size="lg"
                  autoFocus
                >
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                </PinInput>
                <FormHelperText fontSize="xs" mt={2} color="gray.500">
                  認証アプリで表示された最新のコードを入力してください。
                </FormHelperText>
              </FormControl>
            </Stack>
          </ModalBody>
          <ModalFooter>
            <ButtonGroup spacing={3}>
              <Button
                variant="ghost"
                onClick={() => {
                  onClose();
                  setQrUrl(null);
                  setCode('');
                }}
              >
                閉じる
              </Button>
              <Button
                colorScheme="primary"
                isLoading={loading}
                isDisabled={!qrUrl || code.length !== 6}
                onClick={async () => {
                  const ok = await verify();
                  if (ok) onClose();
                }}
              >
                有効化を確定
              </Button>
            </ButtonGroup>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={disableModal.isOpen}
        onClose={() => {
          disableModal.onClose();
          setDisableCode('');
        }}
        isCentered
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>二段階認証の無効化</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Stack spacing={4} align="center">
              <StatusBanner
                status="warning"
                description="無効化するとログイン時の追加認証が不要になります。実行する前に運用ポリシーを確認してください。"
                variant="left-accent"
                w="100%"
              />
              <FormControl textAlign="center">
                <FormLabel>6桁コード</FormLabel>
                <PinInput
                  otp
                  value={disableCode}
                  onChange={(value) => setDisableCode(value)}
                  size="lg"
                  autoFocus
                >
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                  <PinInputField />
                </PinInput>
                <FormHelperText fontSize="xs" mt={2} color="gray.500">
                  現在の認証アプリに表示されているコードを入力してください。
                </FormHelperText>
              </FormControl>
            </Stack>
          </ModalBody>
          <ModalFooter>
            <ButtonGroup spacing={3}>
              <Button
                variant="ghost"
                onClick={() => {
                  disableModal.onClose();
                  setDisableCode('');
                }}
              >
                キャンセル
              </Button>
              <Button
                colorScheme="red"
                isLoading={loading}
                isDisabled={disableCode.length !== 6}
                onClick={disableTotp}
              >
                無効化する
              </Button>
            </ButtonGroup>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Stack>
  );
}
