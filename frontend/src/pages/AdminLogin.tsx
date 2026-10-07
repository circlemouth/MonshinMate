import { useState } from 'react';
import { Container, VStack, FormControl, FormLabel, Input, Button, Text, Heading } from '@chakra-ui/react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { acceptAdminToken, adminJson } from '../utils/adminApi';
import { useRequestScope } from '../hooks/useRequestScope';
import AdminEnrollment from '../components/AdminEnrollment';

type Props = { inModal?: boolean; onSuccess?: () => void };
export default function AdminLogin({ inModal = false, onSuccess }: Props) {
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState('');
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const scope = useRequestScope();
  const submit = async () => {
    const request = scope.start();
    setBusy(true); setError('');
    try {
      const data = challenge
        ? await adminJson('/admin/login/totp', { challenge_token: challenge, totp_code: code }, {}, request.signal)
        : await adminJson('/admin/login', { password }, {}, request.signal);
      request.assertCurrent();
      setPassword(''); setCode('');
      if (data.status === 'totp_required') {
        if (!data.challenge_token) throw new Error('ログインを最初からやり直してください');
        setChallenge(data.challenge_token);
        return;
      }
      if (data.status === 'enrollment_required') {
        if (!data.enrollment_token) throw new Error('登録資格情報がありません。ログインをやり直してください');
        setChallenge(''); setEnrollmentToken(data.enrollment_token);
        return;
      }
      request.assertCurrent();
      acceptAdminToken(data);
      setChallenge('');
      onSuccess?.();
      navigate('/admin/main', { replace: true });
    } catch (e) {
      if (!request.current()) return;
      setError(e instanceof Error ? e.message : 'ログインに失敗しました');
      // A rejected or expired challenge must never fall back to code-only login.
      setChallenge(''); setCode('');
    } finally { if (request.current()) setBusy(false); }
  };
  if (enrollmentToken) return <AdminEnrollment mode="bootstrap" initialToken={enrollmentToken} onComplete={onSuccess} onCancel={() => setEnrollmentToken('')} />;
  const content = <VStack as="form" onSubmit={e => { e.preventDefault(); if (!busy) void submit(); }} spacing={5} p={6} w="100%" maxW="md">
    <Heading size="lg">管理者ログイン</Heading>
    <FormControl>
      <FormLabel>{challenge ? '確認コード（5分以内）' : 'パスワード'}</FormLabel>
      {challenge ? <Input value={code} onChange={e => setCode(e.target.value)} maxLength={6} inputMode="numeric" autoComplete="one-time-code" /> : <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />}
    </FormControl>
    <Button type="submit" isLoading={busy} colorScheme="primary">{challenge ? '認証してログイン' : 'ログイン'}</Button>
    {challenge && <Text fontSize="sm">直前に使用したコードは再利用できません。アプリの次のコード（約30秒ごと）をお待ちください。</Text>}
    {challenge && <Button variant="link" onClick={() => { scope.cancel(); setBusy(false); setChallenge(''); setCode(''); }}>パスワード入力へ戻る</Button>}
    {error && <Text color="red.600" role="alert">{error}</Text>}
    <Button as={RouterLink} to="/admin/initial-password" onClick={onSuccess} variant="link" size="sm">初期登録</Button>
    <Button as={RouterLink} to="/admin/password/reset" onClick={onSuccess} variant="link" size="sm">専用資格情報でアカウントを復旧</Button>
  </VStack>;
  return inModal ? content : <Container centerContent pt={10}>{content}</Container>;
}
