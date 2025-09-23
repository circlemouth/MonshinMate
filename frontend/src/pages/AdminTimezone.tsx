import { ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Stack,
  Heading,
  Text,
  FormControl,
  FormLabel,
  Select,
  Button,
  HStack,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  useToast,
} from '@chakra-ui/react';
import { useTimezone } from '../contexts/TimezoneContext';

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
  const [timezoneSaving, setTimezoneSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setSelectedTimezone(timezone);
  }, [timezone]);

  const timezoneOptions = useMemo(() => {
    const supported = (Intl as any)?.supportedValuesOf?.('timeZone');
    const baseList: string[] = Array.isArray(supported) && supported.length > 0 ? [...supported] : ['Asia/Tokyo', 'UTC', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong'];
    if (!baseList.includes(timezone)) {
      baseList.push(timezone);
    }
    return baseList.sort((a, b) => a.localeCompare(b));
  }, [timezone]);

  const saveTimezoneSetting = async () => {
    setTimezoneSaving(true);
    const payload = { timezone: selectedTimezone || 'Asia/Tokyo' };
    try {
      const res = await fetch('/system/timezone', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error('時間帯の保存に失敗しました');
      }
      const data = await res.json();
      const savedTz = data?.timezone || payload.timezone;
      setTimezone(savedTz);
      toast({
        title: '時間帯を保存しました',
        status: 'success',
        duration: 3000,
        isClosable: true,
        position: 'top-right',
      });
    } catch (e: any) {
      const message = e?.message || '時間帯の保存に失敗しました';
      toast({
        title: '保存に失敗しました',
        description: message,
        status: 'error',
        duration: 4000,
        isClosable: true,
        position: 'top-right',
      });
    } finally {
      setTimezoneSaving(false);
    }
  };

  return (
    <Stack spacing={6} align="stretch">
      <Stack spacing={1} align="flex-start">
        <Heading size="lg">タイムゾーン設定</Heading>
        <Text fontSize="sm" color="fg.muted">
          管理画面の日時表示に使用する時間帯を統一します。
        </Text>
      </Stack>

      <Section
        title="時間帯の設定"
        description="管理画面などで表示する日時の基準となる時間帯を選択できます。"
        footer={
          <HStack justify="flex-end" spacing={4} w="100%">
            <Button onClick={saveTimezoneSetting} colorScheme="primary" isLoading={timezoneSaving}>
              保存
            </Button>
          </HStack>
        }
      >
        <FormControl>
          <FormLabel>表示に使用する時間帯</FormLabel>
          <Select value={selectedTimezone} onChange={(e) => setSelectedTimezone(e.target.value)}>
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
          <Text fontSize="sm" color="fg.muted" mt={2}>
            表示される日時はここで設定した時間帯で自動的に変換されます。既定値は Asia/Tokyo (JST) です。
          </Text>
        </FormControl>
        <Text fontSize="sm" color="fg.muted">
          保存後はセッション一覧や詳細画面などの日時表示が即座に切り替わります。
        </Text>
      </Section>
    </Stack>
  );
}
