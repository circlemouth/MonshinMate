import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertDialog, AlertDialogBody, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogOverlay, Button } from '@chakra-ui/react';
import { useRef } from 'react';
import { clearPatientSession, getPatientSession, PATIENT_CLEARED, canAccessPatientRoute, patientIdleState } from '../utils/patientSession';
import { flushQueue } from '../retryQueue';
import { useNotify } from '../contexts/NotificationContext';

export function PatientGuard({ children, entry = false }: { children: ReactNode; entry?: boolean }) {
  const [, update] = useState(0);
  useEffect(() => {
    const onClear = () => update(value => value + 1);
    window.addEventListener(PATIENT_CLEARED, onClear);
    return () => window.removeEventListener(PATIENT_CLEARED, onClear);
  }, []);
  if (!canAccessPatientRoute(entry)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function PatientSafety() {
  const location = useLocation();
  const navigate = useNavigate();
  const { closeAll } = useNotify();
  const [warning, setWarning] = useState(false);
  const continueRef = useRef<HTMLButtonElement>(null);
  const active = ['/basic-info', '/questionnaire', '/questions', '/llm-wait'].includes(location.pathname);
  const touch = () => { sessionStorage.setItem('patient_last_activity', String(Date.now())); setWarning(false); };
  const leave = () => { clearPatientSession(); setWarning(false); navigate('/', { replace: true }); };

  useEffect(() => {
    const onClear = () => { closeAll(); setWarning(false); };
    const onPageHide = () => { clearPatientSession(); };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) { clearPatientSession(); navigate('/', { replace: true }); }
    };
    const onOnline = () => { void flushQueue(); };
    window.addEventListener(PATIENT_CLEARED, onClear);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener(PATIENT_CLEARED, onClear);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
    };
  }, [closeAll, navigate]);

  useEffect(() => {
    if (!active) { setWarning(false); return; }
    if (!sessionStorage.getItem('patient_last_activity')) touch();
    const check = () => {
      const idle = patientIdleState();
      if (idle === 'expired' || (sessionStorage.getItem('session_id') && !getPatientSession())) leave();
      else setWarning(idle === 'warning');
    };
    const activity = () => {
      const idle = patientIdleState();
      if (idle === 'expired') { leave(); return; }
      // Once warned, only the explicit Continue action extends this patient's session.
      if (idle === 'active') touch();
    };
    check();
    const timer = window.setInterval(check, 1000);
    const retryTimer = window.setInterval(() => { void flushQueue(); }, 15_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => {
      clearInterval(timer); clearInterval(retryTimer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
    };
  }, [active, navigate]);

  return <AlertDialog isOpen={active && warning} leastDestructiveRef={continueRef} onClose={() => {}} closeOnOverlayClick={false} closeOnEsc={false}>
    <AlertDialogOverlay><AlertDialogContent>
      <AlertDialogHeader>問診を続けますか？</AlertDialogHeader>
      <AlertDialogBody>15分間操作がありません。個人情報保護のため、1分後にこの端末の入力内容を消去してトップ画面へ戻ります。</AlertDialogBody>
      <AlertDialogFooter><Button onClick={leave}>入力を消去して終了</Button><Button ref={continueRef} colorScheme="primary" ml={3} onClick={() => {
        if (patientIdleState() === 'expired') leave(); else touch();
      }}>続ける</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialogOverlay>
  </AlertDialog>;
}
