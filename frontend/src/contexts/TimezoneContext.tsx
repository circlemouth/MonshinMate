import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';

const DEFAULT_TIMEZONE = 'Asia/Tokyo';

type FormatOptions = {
  includeTime?: boolean;
};

interface TimezoneContextValue {
  timezone: string;
  setTimezone: (tz: string) => void;
  formatDateTime: (iso?: string | null, options?: FormatOptions) => string;
  formatDate: (iso?: string | null) => string;
}

const TimezoneContext = createContext<TimezoneContextValue | undefined>(undefined);

function formatWithTimezone(
  iso: string | null | undefined,
  timezone: string,
  options: FormatOptions = { includeTime: true }
): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const datePart = date.toLocaleDateString('sv-SE', { timeZone: timezone });
  if (options.includeTime === false) {
    return datePart;
  }
  const timePart = date.toLocaleTimeString('sv-SE', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${datePart} ${timePart}`;
}

export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezoneState] = useState<string>(DEFAULT_TIMEZONE);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const r = await fetch('/system/timezone');
        if (!r.ok) return;
        const d = await r.json();
        if (mounted && d?.timezone) {
          setTimezoneState(d.timezone);
        }
      } catch {
        // ignore network errors; fallback to default timezone
      }
    })();
    const handler = (event: any) => {
      if (!mounted) return;
      const tz = event?.detail;
      if (typeof tz === 'string' && tz) {
        setTimezoneState(tz);
      }
    };
    window.addEventListener('systemTimezoneUpdated' as any, handler);
    return () => {
      mounted = false;
      window.removeEventListener('systemTimezoneUpdated' as any, handler);
    };
  }, []);

  const setTimezone = (tz: string) => {
    const next = tz || DEFAULT_TIMEZONE;
    setTimezoneState(next);
    window.dispatchEvent(new CustomEvent('systemTimezoneUpdated', { detail: next }));
  };

  const value = useMemo<TimezoneContextValue>(
    () => ({
      timezone,
      setTimezone,
      formatDateTime: (iso, options) => formatWithTimezone(iso, timezone, options),
      formatDate: (iso) => formatWithTimezone(iso, timezone, { includeTime: false }),
    }),
    [timezone]
  );

  return <TimezoneContext.Provider value={value}>{children}</TimezoneContext.Provider>;
}

export function useTimezone() {
  const ctx = useContext(TimezoneContext);
  if (!ctx) {
    throw new Error('useTimezone must be used within TimezoneProvider');
  }
  return ctx;
}
