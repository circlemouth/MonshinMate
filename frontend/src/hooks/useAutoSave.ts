import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface UseAutoSaveOptions<T> {
  value: T;
  save: (value: T, signal: AbortSignal) => Promise<T | void>;
  delay?: number;
  enabled?: boolean;
  compare?: (next: T, prev: T | null) => boolean;
  onError?: (error: unknown, message: string) => void;
}

interface UseAutoSaveResult<T> {
  status: AutoSaveStatus;
  errorMessage: string | null;
  markSynced: (value: T) => void;
}

const defaultCompare = <T,>(next: T, prev: T | null) => Object.is(next, prev);

/**
 * Debounced auto-save hook for admin settings.
 * - Call `markSynced` after the initial load (or external updates) to register the current value as "saved".
 * - When the value diverges from the last synced value, `save` is invoked after the specified delay.
 */
export function useAutoSave<T>({
  value,
  save,
  delay = 800,
  enabled = true,
  compare = defaultCompare,
  onError,
}: UseAutoSaveOptions<T>): UseAutoSaveResult<T> {
  const lastSavedRef = useRef<T | null>(null);
  const hasSyncedRef = useRef(false);
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markSynced = useCallback((syncedValue: T) => {
    lastSavedRef.current = syncedValue;
    hasSyncedRef.current = true;
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      hasSyncedRef.current = false;
      lastSavedRef.current = null;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
      setStatus('idle');
      setErrorMessage(null);
    }
  }, [enabled]);

  useEffect(() => () => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!hasSyncedRef.current) return;
    if (compare(value, lastSavedRef.current)) return;

    let active = true;
    const controller = new AbortController();
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatus('saving');
    setErrorMessage(null);

    const timer = setTimeout(async () => {
      try {
        const result = await save(value, controller.signal);
        if (!active) return;
        const savedValue = (result ?? value) as T;
        lastSavedRef.current = savedValue;
        setStatus('saved');
        statusTimerRef.current = setTimeout(() => {
          if (active) {
            setStatus('idle');
          }
        }, 1500);
      } catch (err) {
        if (!active) return;
        if ((err as any)?.name === 'AbortError' || controller.signal.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : '保存に失敗しました';
        setErrorMessage(message);
        setStatus('error');
        onError?.(err, message);
      }
    }, delay);

    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [value, enabled, compare, delay, save, onError]);

  return { status, errorMessage, markSynced };
}
