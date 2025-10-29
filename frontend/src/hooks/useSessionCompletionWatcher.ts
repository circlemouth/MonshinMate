import { useEffect, useRef, useState } from 'react';
import { useNotify } from '../contexts/NotificationContext';
import { useNavigate, useLocation } from 'react-router-dom';

interface SessionFinalizeEvent {
  id: string;
  patient_name?: string | null;
  dob?: string | null;
  visit_type?: string | null;
  started_at?: string | null;
  finalized_at: string;
}

const STORAGE_KEY_LATEST = 'monshin.admin.latestFinalizedAt';
const STORAGE_KEY_PROMPTED = 'monshin.admin.desktopNotificationPrompted';
const STORAGE_KEY_NATIVE_NOTIFICATIONS = 'monshin.admin.nativeNotificationsEnabled';

const STREAM_ENDPOINT = '/admin/sessions/stream';

const visitTypeLabel = (value: string | null | undefined): string => {
  switch (value) {
    case 'initial':
      return '初診';
    case 'followup':
      return '再診';
    case 'home_visit':
      return '往診';
    case 'telemedicine':
      return '遠隔';
    case 'other':
      return 'その他';
    case '':
    case null:
    case undefined:
      return '未設定';
    default:
      return value;
  }
};

const formatPatientLabel = (name: string | null | undefined, dob: string | null | undefined) => {
  const displayName = name?.trim() || '患者名未入力';
  return dob ? `${displayName} (${dob})` : displayName;
};

export function useSessionCompletionWatcher() {
  const { notify } = useNotify();
  const navigate = useNavigate();
  const location = useLocation();
  const [nativeNotificationsEnabled, setNativeNotificationsEnabled] = useState(false);
  const permissionRef = useRef<'default' | 'denied' | 'granted' | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let disposed = false;

    const normalizePreference = (value: unknown): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
        if (['false', '0', 'no', 'off'].includes(lowered)) return false;
        return Boolean(value);
      }
      if (typeof value === 'number') return value !== 0;
      return Boolean(value);
    };

    const applyPreference = (value: unknown) => {
      if (disposed) return;
      const normalized = normalizePreference(value);
      setNativeNotificationsEnabled(normalized);
      if (normalized) {
        try {
          localStorage.removeItem(STORAGE_KEY_PROMPTED);
        } catch {
          // ignore storage quota or availability errors
        }
      }
    };

    const readPreferenceFromStorage = () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_NATIVE_NOTIFICATIONS);
        if (raw === null) {
          applyPreference(false);
        } else {
          applyPreference(raw);
        }
      } catch {
        applyPreference(false);
      }
    };

    const handleUpdated = (event: Event) => {
      const custom = event as CustomEvent<{ enabled?: boolean }>;
      applyPreference(custom.detail?.enabled ?? false);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== STORAGE_KEY_NATIVE_NOTIFICATIONS) {
        return;
      }
      readPreferenceFromStorage();
    };

    readPreferenceFromStorage();
    window.addEventListener('systemNativeNotificationsUpdated', handleUpdated as EventListener);
    window.addEventListener('storage', handleStorage);

    return () => {
      disposed = true;
      window.removeEventListener('systemNativeNotificationsUpdated', handleUpdated as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('EventSource' in window)) {
      console.warn('EventSource is not supported; admin session notifications are disabled.');
      return;
    }

    let disposed = false;
    let eventSource: EventSource | null = null;
    let lastSince: string | null = sessionStorage.getItem(STORAGE_KEY_LATEST);
    let lastErrorAt = 0;

    const updatePermissionState = (value?: NotificationPermission) => {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        permissionRef.current = 'unsupported';
        return;
      }
      if (value) {
        permissionRef.current = value;
      } else {
        permissionRef.current = Notification.permission;
      }
    };

    const ensurePermissionPrompt = () => {
      if (!nativeNotificationsEnabled) return;
      if (permissionRef.current === 'unsupported') return;
      updatePermissionState();
      if (permissionRef.current !== 'default') return;
      if (localStorage.getItem(STORAGE_KEY_PROMPTED)) return;

      localStorage.setItem(STORAGE_KEY_PROMPTED, '1');
      notify({
        channel: 'admin',
        status: 'info',
        title: 'デスクトップ通知を有効化できます',
        description: '問診完了時にブラウザ通知でお知らせできます。許可の設定をお願いします。',
        actionLabel: '通知を許可',
        dismissOnAction: true,
        onAction: async () => {
          try {
            const result = await Notification.requestPermission();
            updatePermissionState(result);
            if (result === 'granted') {
              notify({
                channel: 'admin',
                status: 'success',
                title: '通知を許可しました',
                description: '問診完了時にデスクトップ通知が表示されます。',
              });
            } else if (result === 'denied') {
              notify({
                channel: 'admin',
                status: 'warning',
                title: '通知は許可されませんでした',
                description: 'ブラウザ設定から通知を許可するまでデスクトップ通知は表示されません。',
              });
            }
          } catch (error) {
            console.error('failed to request notification permission', error);
            notify({
              channel: 'admin',
              status: 'error',
              title: '通知の許可に失敗しました',
              description: 'ブラウザ設定をご確認のうえ、再度お試しください。',
            });
          }
        },
        duration: null,
      });
    };

    const updateSince = (value: string | null | undefined) => {
      if (!value) return;
      lastSince = value;
      sessionStorage.setItem(STORAGE_KEY_LATEST, value);
    };

    const openSessionsPage = () => {
      if (location.pathname !== '/admin/sessions') {
        navigate('/admin/sessions');
      } else {
        // ページ内で最新データを再取得したい場合に備えてイベントを投げる
        window.dispatchEvent(new CustomEvent('adminSessionsRefreshRequested'));
      }
    };

    const showDesktopNotification = (title: string, body: string, sessionId?: string) => {
      if (!nativeNotificationsEnabled) return;
      if (permissionRef.current !== 'granted') return;
      try {
        const notification = new Notification(title, {
          body,
          tag: sessionId ? `monshin-session-${sessionId}` : 'monshin-session-batch',
          renotify: true,
          data: sessionId ? { sessionId } : undefined,
        });
        notification.onclick = () => {
          window.focus();
          openSessionsPage();
          notification.close();
        };
      } catch (error) {
        console.warn('failed to show desktop notification', error);
      }
    };

    const notifySessions = (events: SessionFinalizeEvent[]) => {
      if (!events.length) return;
      if (events.length === 1) {
        const event = events[0];
        const patient = formatPatientLabel(event.patient_name ?? null, event.dob ?? null);
        const visit = visitTypeLabel(event.visit_type);
        const description = `${patient} / 区分: ${visit}`;

        notify({
          channel: 'admin',
          status: 'info',
          title: '新しい問診が完了しました',
          description,
          actionLabel: '問診結果を確認',
          onAction: () => openSessionsPage(),
        });

        const bodyLines = [description];
        if (event.finalized_at) {
          bodyLines.push(`完了時刻: ${event.finalized_at}`);
        }
        showDesktopNotification('新しい問診が完了しました', bodyLines.join('\n'), event.id);
      } else {
        const latest = events[events.length - 1];
        const patient = formatPatientLabel(latest.patient_name ?? null, latest.dob ?? null);
        const visit = visitTypeLabel(latest.visit_type);
        const summary = `${patient} / 区分: ${visit}`;

        notify({
          channel: 'admin',
          status: 'info',
          title: `${events.length}件の問診が完了しました`,
          description: `最新: ${summary}`,
          actionLabel: '問診結果を確認',
          onAction: () => openSessionsPage(),
        });

        const bodyLines = [`${events.length}件の問診が完了しました`, `最新: ${summary}`];
        showDesktopNotification('問診完了のお知らせ', bodyLines.join('\n'));
      }
    };

    const handleEventPayload = (event: SessionFinalizeEvent | null | undefined) => {
      if (!event || !event.finalized_at) return;
      const finalizedAt = event.finalized_at;
      const isDuplicate = lastSince !== null && finalizedAt <= lastSince;
      updateSince(finalizedAt);
      if (isDuplicate) return;
      lastErrorAt = 0;
      notifySessions([event]);
    };

    const handleStreamMessage = (message: MessageEvent<string>) => {
      if (disposed) return;
      if (!message.data) return;
      try {
        const parsed = JSON.parse(message.data) as SessionFinalizeEvent | SessionFinalizeEvent[];
        if (Array.isArray(parsed)) {
          parsed.forEach((event) => handleEventPayload(event));
        } else {
          handleEventPayload(parsed);
        }
      } catch (error) {
        console.warn('failed to parse session notification payload', error);
      }
    };

    const connectStream = () => {
      if (disposed) return;
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      const params = new URLSearchParams();
      if (lastSince) {
        params.set('since', lastSince);
      }
      const qs = params.toString();
      const streamUrl = `${STREAM_ENDPOINT}${qs ? `?${qs}` : ''}`;
      const source = new EventSource(streamUrl);
      eventSource = source;
      const handler = (evt: MessageEvent<string>) => handleStreamMessage(evt);
      source.onmessage = handler;
      source.addEventListener('session.finalized', handler as EventListener);
      source.onerror = (error) => {
        if (disposed) return;
        console.warn('session notification stream error', error);
        const now = Date.now();
        if (!lastErrorAt || now - lastErrorAt > 5 * 60 * 1000) {
          lastErrorAt = now;
          notify({
            channel: 'admin',
            status: 'warning',
            title: '問診完了通知の受信に失敗しました',
            description: 'ネットワーク状態を確認後、ページを再読み込みしてください。',
          });
        }
      };
    };

    ensurePermissionPrompt();
    connectStream();

    return () => {
      disposed = true;
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }, [notify, navigate, location.pathname, nativeNotificationsEnabled]);
}
