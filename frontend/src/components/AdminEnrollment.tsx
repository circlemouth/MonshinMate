import { useState } from 'react';
import { VStack, Heading, Text, Input, Button, Image, FormControl, FormLabel } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { useRequestScope } from '../hooks/useRequestScope';
import type { ViewRequest } from '../utils/requestScope';
import { acceptAdminToken, adminJson } from '../utils/adminApi';

// Limited-purpose credentials and QR material exist only in this mounted component.
export default function AdminEnrollment({ mode, initialToken = '', onComplete, onCancel }: { mode: 'bootstrap' | 'recovery'; initialToken?: string; onComplete?: () => void; onCancel?: () => void }) {
  const navigate = useNavigate();
  const [credential, setCredential] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [enrollmentToken, setEnrollmentToken] = useState(initialToken);
  const [enrollmentId, setEnrollmentId] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const scope = useRequestScope();
  const setup = async (token: string, request: ViewRequest) => {
    request.assertCurrent();
    const data = await adminJson('/admin/totp/setup', {}, { Authorization: `Bearer ${token}` }, request.signal);
    request.assertCurrent();
    setEnrollmentId(data.enrollment_id);
    setQr(data.qr_code_data_url);
  };
  const start = async () => {
    if (password.length < 12 || new TextEncoder().encode(password).length > 72 || password !== confirmation) {
      setError('新しいパスワードは12文字以上・UTF-8で72バイト以内で、確認欄と一致するよう入力してください。');
      return;
    }
    const request = scope.start();
    setBusy(true); setError('');
    try {
      const data = await adminJson(`/admin/${mode}`, { credential, new_password: password }, {}, request.signal);
      request.assertCurrent();
      if (data.status === 'ok') {
        request.assertCurrent();
        acceptAdminToken(data);
        setCredential(''); setPassword(''); setConfirmation('');
        onComplete?.();
        navigate('/admin/main', { replace: true });
        return;
      }
      if (data.status !== 'enrollment_required' || !data.enrollment_token) throw new Error('登録資格情報がありません。');
      setCredential(''); setPassword(''); setConfirmation('');
      setEnrollmentToken(data.enrollment_token);
      await setup(data.enrollment_token, request);
    } catch (e) { if (request.current()) setError(e instanceof Error ? e.message : '設定に失敗しました'); }
    finally { if (request.current()) setBusy(false); }
  };
  const verify = async () => {
    const request = scope.start();
    setBusy(true); setError('');
    try {
      const data = await adminJson('/admin/totp/verify', { enrollment_id: enrollmentId, totp_code: code }, { Authorization: `Bearer ${enrollmentToken}` }, request.signal);
      request.assertCurrent();
      acceptAdminToken(data);
      setEnrollmentToken(''); setQr(''); setCode('');
      onComplete?.();
      navigate('/admin/main', { replace: true });
    } catch (e) { if (request.current()) setError(e instanceof Error ? e.message : '確認に失敗しました'); }
    finally { if (request.current()) setBusy(false); }
  };
  return <VStack spacing={5} maxW="md" mx="auto" p={6} align="stretch">
    <Heading size="md">{mode === 'bootstrap' ? '管理者の初期登録' : '管理者アカウントの復旧'}</Heading>
    {!enrollmentToken ? <>
      <Text>サーバ管理者から発行された専用の{mode === 'bootstrap' ? '初期登録' : '復旧'}資格情報を入力してください。</Text>
      <FormControl><FormLabel>専用資格情報</FormLabel><Input type="password" autoComplete="off" value={credential} onChange={e => setCredential(e.target.value)} /></FormControl>
      <FormControl><FormLabel>新しいパスワード</FormLabel><Input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></FormControl>
      <FormControl><FormLabel>新しいパスワード（確認）</FormLabel><Input type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></FormControl>
      <Button onClick={start} isLoading={busy} colorScheme="primary">登録・復旧を進める</Button>
    </> : <>
      <Text>10分以内にAuthenticatorでQRコードを読み取り、6桁のコードを入力してください。コード確認完了まで管理画面は利用できません。</Text>
      {qr && <Image src={qr} alt="Authenticator 登録用QRコード" maxW="280px" />}
      {!enrollmentId && <Button isLoading={busy} onClick={async () => { const request = scope.start(); setBusy(true); try { await setup(enrollmentToken, request); } catch { if (request.current()) setError('期限切れの場合は最初からやり直してください'); } finally { if (request.current()) setBusy(false); } }}>QRコードを取得</Button>}
      <Input aria-label="確認コード" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value)} />
      <Button onClick={verify} isDisabled={!enrollmentId || code.length !== 6} isLoading={busy} colorScheme="primary">登録を完了</Button>
    </>}
    {error && <Text role="alert" color="red.600">{error}</Text>}
    <Button variant="link" onClick={() => { scope.cancel(); onCancel?.(); navigate('/admin/login', { replace: true }); }}>ログイン画面へ戻る</Button>
  </VStack>;
}
