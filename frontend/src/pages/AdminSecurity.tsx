import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { VStack, Heading, Text, Input, Button, Image, FormControl, FormLabel } from '@chakra-ui/react';
import { useNavigate } from 'react-router-dom';
import { useRequestScope } from '../hooks/useRequestScope';
import type { ViewRequest } from '../utils/requestScope';
import { adminJson, acceptAdminToken, clearAdminSession } from '../utils/adminApi';

export default function AdminSecurity() {
  const navigate = useNavigate();
  const { isTotpEnabled, mfaRequired, checkAuthStatus } = useAuth();
  useEffect(() => { void checkAuthStatus(true); }, [checkAuthStatus]);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [reauth, setReauth] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');
  const [qr, setQr] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scope = useRequestScope();
  const run = async (work: (request: ViewRequest) => Promise<void>) => {
    const request = scope.start();
    setBusy(true); setError('');
    try { await work(request); } catch (e) { if (request.current()) setError(e instanceof Error ? e.message : '処理に失敗しました'); }
    finally { if (request.current()) setBusy(false); }
  };
  const reauthenticate = async (request: ViewRequest) => {
    const data = await adminJson('/admin/reauth', { password, totp_code: isTotpEnabled ? code || undefined : undefined }, {}, request.signal);
    request.assertCurrent();
    return { 'X-Admin-Reauth': data.reauth_token };
  };
  const setup = () => run(async (request) => {
    const headers = await reauthenticate(request);
    request.assertCurrent();
    const data = await adminJson('/admin/totp/setup', {}, headers, request.signal);
    request.assertCurrent();
    setReauth(headers['X-Admin-Reauth']);
    setEnrollmentId(data.enrollment_id); setQr(data.qr_code_data_url);
    setPassword(''); setCode('');
  });
  const verify = () => run(async (request) => {
    const data = await adminJson('/admin/totp/verify', { enrollment_id: enrollmentId, totp_code: verifyCode }, { 'X-Admin-Reauth': reauth }, request.signal);
    request.assertCurrent();
    acceptAdminToken(data);
    setQr(''); setEnrollmentId(''); setReauth(''); setVerifyCode('');
    await checkAuthStatus(true);
  });
  const changePassword = () => run(async (request) => {
    if (newPassword.length < 12 || new TextEncoder().encode(newPassword).length > 72 || newPassword !== confirmation) throw new Error('新パスワードは12文字以上・UTF-8で72バイト以内で、確認欄と一致させてください');
    const headers = await reauthenticate(request);
    request.assertCurrent();
    await adminJson('/admin/password/change', { current_password: password, new_password: newPassword }, headers, request.signal);
    request.assertCurrent();
    clearAdminSession();
    navigate('/admin/login', { replace: true });
  });
  return <VStack maxW="lg" spacing={5} align="stretch" py={6}>
    <Heading size="lg">セキュリティ</Heading>
    <Text>変更の直前に現在のパスワード{isTotpEnabled ? 'とAuthenticatorコード' : ''}で再認証します。パスワード変更後は再ログインが必要です。二段階認証の設定は維持されます。</Text>
    <Text>二段階認証: {isTotpEnabled ? '有効' : '未登録'}。{mfaRequired === null ? 'サーバーの必須ポリシーは未確認です。' : mfaRequired ? 'サーバーのポリシーで登録が必須です。' : 'サーバーのポリシーでは登録は任意です。登録済みの場合は確認コードが必要です。'}</Text>
    {isTotpEnabled && <Text>直前に使用したコードは再利用できません。アプリの次のコード（約30秒ごと）をお待ちください。</Text>}
    <FormControl><FormLabel>現在のパスワード</FormLabel><Input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></FormControl>
    {isTotpEnabled && <FormControl><FormLabel>現在のAuthenticatorコード</FormLabel><Input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} onChange={e => setCode(e.target.value)} /></FormControl>}
    <FormControl><FormLabel>新しいパスワード</FormLabel><Input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></FormControl>
    <FormControl><FormLabel>新しいパスワード（確認）</FormLabel><Input type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></FormControl>
    <Button onClick={changePassword} isLoading={busy}>パスワードを変更</Button>
    <Button onClick={setup} isLoading={busy}>Authenticatorを登録・再登録</Button>
    {qr && <>
      <Text>QRコードを読み取り、5分以内に新しいアプリのコードを確認してください。確認前は現在の二段階認証の設定が維持されます。</Text>
      <Image src={qr} alt="Authenticator 登録用QRコード" maxW="280px" />
      <Input aria-label="新しいAuthenticatorコード" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={verifyCode} onChange={e => setVerifyCode(e.target.value)} />
      <Button onClick={verify} isLoading={busy}>登録を確認</Button>
    </>}
    <Text fontSize="sm">この画面では登録済みの二段階認証を無効化できません。ログインできない場合はサーバ管理者へ復旧を依頼してください。</Text>
    {error && <Text role="alert" color="red.600">{error}</Text>}
  </VStack>;
}
