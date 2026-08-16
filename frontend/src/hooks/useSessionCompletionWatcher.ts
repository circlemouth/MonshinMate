import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useNotify } from '../contexts/NotificationContext';

interface SessionFinalizeEvent {
  id: string;
  finalized_at: string;
}

interface PushConfig {
  enabled: boolean;
  firebase: Record<string, string>;
  vapidKey: string;
}

const STORAGE_KEY_LATEST = 'monshin.admin.latestFinalizedAt';
const STORAGE_KEY_PROMPTED = 'monshin.admin.desktopNotificationPrompted';
const STORAGE_KEY_NATIVE_NOTIFICATIONS = 'monshin.admin.nativeNotificationsEnabled';
const POLL_INTERVAL_MS = 60_000;

export function useSessionCompletionWatcher() {
  const { notify } = useNotify();
  const navigate = useNavigate();
  const location = useLocation();
  const [nativeEnabled, setNativeEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );

  useEffect(() => {
    const readPreference = () => {
      try {
        setNativeEnabled(localStorage.getItem(STORAGE_KEY_NATIVE_NOTIFICATIONS) === 'true');
      } catch {
        setNativeEnabled(false);
      }
    };
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      setNativeEnabled(Boolean(detail?.enabled));
    };
    readPreference();
    window.addEventListener('systemNativeNotificationsUpdated', onUpdated as EventListener);
    window.addEventListener('storage', readPreference);
    return () => {
      window.removeEventListener('systemNativeNotificationsUpdated', onUpdated as EventListener);
      window.removeEventListener('storage', readPreference);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let pollTimer: number | undefined;
    let unsubscribeMessage: (() => void) | undefined;
    let lastSince = sessionStorage.getItem(STORAGE_KEY_LATEST) || new Date().toISOString();

    const openSessions = () => {
      if (location.pathname !== '/admin/sessions') navigate('/admin/sessions');
      else window.dispatchEvent(new CustomEvent('adminSessionsRefreshRequested'));
    };

    const announce = (count: number, finalizedAt?: string) => {
      if (finalizedAt && finalizedAt > lastSince) {
        lastSince = finalizedAt;
        sessionStorage.setItem(STORAGE_KEY_LATEST, finalizedAt);
      }
      window.dispatchEvent(new CustomEvent('adminSessionsRefreshRequested'));
      notify({
        channel: 'admin',
        status: 'info',
        title: count > 1 ? `${count}件の問診が完了しました` : '新しい問診が完了しました',
        description: '問診結果一覧で内容をご確認ください。',
        actionLabel: '問診結果を確認',
        onAction: openSessions,
      });
    };

    const poll = async () => {
      if (disposed || document.visibilityState !== 'visible') return;
      try {
        const response = await fetch(
          `/admin/sessions/completed?since=${encodeURIComponent(lastSince)}&limit=50`,
        );
        if (!response.ok) return;
        const events: SessionFinalizeEvent[] = await response.json();
        if (events.length) announce(events.length, events[events.length - 1].finalized_at);
      } catch {
        // 次のポーリングで回復する。常時エラー通知は表示しない。
      }
    };

    const startPolling = () => {
      void poll();
      pollTimer = window.setInterval(poll, POLL_INTERVAL_MS);
    };

    const setupPush = async (): Promise<boolean> => {
      if (!nativeEnabled || permission !== 'granted') return false;
      const [{ getApp, getApps, initializeApp }, messagingModule] = await Promise.all([
        import('firebase/app'),
        import('firebase/messaging'),
      ]);
      const { getMessaging, getToken, isSupported, onMessage } = messagingModule;
      if (!(await isSupported())) return false;
      const configResponse = await fetch('/system/push-config');
      if (!configResponse.ok) return false;
      const config: PushConfig = await configResponse.json();
      if (!config.enabled) return false;

      const app = getApps().length ? getApp() : initializeApp(config.firebase);
      const serviceWorker = await navigator.serviceWorker.register(
        `/firebase-messaging-sw.js?config=${encodeURIComponent(JSON.stringify(config.firebase))}`,
      );
      const token = await getToken(getMessaging(app), {
        vapidKey: config.vapidKey,
        serviceWorkerRegistration: serviceWorker,
      });
      const accessToken = sessionStorage.getItem('adminAccessToken');
      if (!token || !accessToken) return false;
      const registerResponse = await fetch('/admin/push-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ token }),
      });
      if (!registerResponse.ok) return false;
      unsubscribeMessage = onMessage(getMessaging(app), (payload) => {
        const finalizedAt = payload.data?.finalized_at;
        announce(1, finalizedAt);
      });
      return true;
    };

    const initialize = async () => {
      if (nativeEnabled && permission === 'default' && !localStorage.getItem(STORAGE_KEY_PROMPTED)) {
        localStorage.setItem(STORAGE_KEY_PROMPTED, '1');
        notify({
          channel: 'admin',
          status: 'info',
          title: 'デスクトップ通知を有効化できます',
          description: '問診完了をPush通知で受け取れます。',
          actionLabel: '通知を許可',
          duration: null,
          onAction: async () => setPermission(await Notification.requestPermission()),
        });
      }
      try {
        if (await setupPush()) return;
      } catch (error) {
        console.warn('push notification setup failed; using polling fallback', error);
      }
      startPolling();
    };

    void initialize();
    return () => {
      disposed = true;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      unsubscribeMessage?.();
    };
  }, [location.pathname, nativeEnabled, navigate, notify, permission]);
}
