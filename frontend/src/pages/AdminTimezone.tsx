import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Stack,
  Heading,
  Text,
  FormControl,
  FormLabel,
  Select,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  useToast,
} from '@chakra-ui/react';
import { useTimezone } from '../contexts/TimezoneContext';
import AutoSaveStatusText from '../components/AutoSaveStatusText';
import { useAutoSave } from '../hooks/useAutoSave';
import { readErrorMessage } from '../utils/http';

function Section({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card variant="outline">
      <CardHeader>
        <Stack spacing={1} align="flex-start">
          <Heading size="md">{title}</Heading>
          {description && (
            <Text fontSize="sm" color="fg.muted">
              {description}
            </Text>
          )}
        </Stack>
      </CardHeader>
      <CardBody>
        <Stack spacing={4} align="stretch">
          {children}
        </Stack>
      </CardBody>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
}

export default function AdminTimezone() {
  const { timezone, setTimezone } = useTimezone();
  const [selectedTimezone, setSelectedTimezone] = useState<string>(timezone);
  const toast = useToast();

  const showErrorToast = useCallback(
    (title: string, description?: string) => {
      toast({
        title,
        description,
        status: 'error',
        duration: 4000,
        isClosable: true,
        position: 'top-right',
      });
    },
    [toast]
  );

  const saveTimezone = useCallback(
    async (nextTimezone: string, signal: AbortSignal) => {
      const payload = { timezone: nextTimezone || 'Asia/Tokyo' };
      const res = await fetch('/system/timezone', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, '時間帯の保存に失敗しました'));
      }
      const data = await res.json().catch(() => ({}));
      const savedTz = data?.timezone || payload.timezone;
      setTimezone(savedTz);
      return savedTz;
    },
    [setTimezone]
  );

  const handleTimezoneError = useCallback(
    (_: unknown, message: string) => {
      showErrorToast('時間帯の保存に失敗しました', message !== '時間帯の保存に失敗しました' ? message : undefined);
    },
    [showErrorToast]
  );

  const {
    status: timezoneStatus,
    errorMessage: timezoneError,
    markSynced: markTimezoneSynced,
  } = useAutoSave<string>({
    value: selectedTimezone,
    save: saveTimezone,
    delay: 400,
    onError: handleTimezoneError,
  });

  useEffect(() => {
    setSelectedTimezone(timezone);
    markTimezoneSynced(timezone);
  }, [timezone, markTimezoneSynced]);

  const timezoneOptions = useMemo(() => {
    const supported = (Intl as any)?.supportedValuesOf?.('timeZone');
    const baseList: string[] = Array.isArray(supported) && supported.length > 0 ? [...supported] : ['Asia/Tokyo', 'UTC', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong'];
    if (!baseList.includes(timezone)) {
      baseList.push(timezone);
    }
    return baseList.sort((a, b) => a.localeCompare(b));
  }, [timezone]);

  return (
    <Stack spacing={6} align="stretch">
      <Stack spacing={1} align="flex-start">
        <Heading size="lg">タイムゾーン設定</Heading>
        <Text fontSize="sm" color="fg.muted">
          管理画面の日時表示に使用する時間帯を統一します。選択内容は自動で保存され、数秒以内に全画面へ反映されます。
        </Text>
      </Stack>

      <Section
        title="時間帯の設定"
        description="管理画面などで表示する日時の基準となる時間帯を選択できます。選択すると自動保存されます。"
      >
        <FormControl>
          <FormLabel>表示に使用する時間帯</FormLabel>
          <Stack spacing={1} align="stretch">
            <Select value={selectedTimezone} onChange={(e) => setSelectedTimezone(e.target.value)}>
              {timezoneOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
            <AutoSaveStatusText status={timezoneStatus} message={timezoneError} />
          </Stack>
          <Text fontSize="sm" color="fg.muted" mt={2}>
            表示される日時はここで設定した時間帯で自動的に変換されます。既定値は Asia/Tokyo (JST) です。
          </Text>
        </FormControl>
        <Text fontSize="sm" color="fg.muted">
          選択後はセッション一覧や詳細画面などの日時表示が即座に切り替わります。
        </Text>
      </Section>
    </Stack>
  );
}
