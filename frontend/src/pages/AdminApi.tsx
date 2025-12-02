import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Code,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Input,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { useNotify } from '../contexts/NotificationContext';

interface PatientSummaryApiInfo {
  endpoint: string;
  header_name: string;
  is_enabled: boolean;
  last_updated_at: string | null;
}

const MIN_KEY_LENGTH = 16;

const formatTimestamp = (value: string | null) => {
  if (!value) return '未設定';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('ja-JP');
};

const buildRandomKey = () => {
  if (crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return Array.from({ length: 32 })
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('');
};

export default function AdminApi() {
  const [info, setInfo] = useState<PatientSummaryApiInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const { notify } = useNotify();
  const toast = useToast();

  const loadInfo = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/system/patient-summary-api');
      if (!res.ok) {
        throw new Error('failed to load');
      }
      const data: PatientSummaryApiInfo = await res.json();
      setInfo(data);
    } catch (err) {
      console.error(err);
      notify({ title: 'API設定の取得に失敗しました', status: 'error', channel: 'admin' });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  const saveKey = useCallback(
    async (value: string | null) => {
      setSaving(true);
      try {
        const body = { api_key: value };
        const res = await fetch('/system/patient-summary-api-key', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const error = await res.json().catch(() => ({}));
          throw new Error(error.detail || '保存に失敗しました');
        }
        const data: PatientSummaryApiInfo = await res.json();
        setInfo(data);
        notify({ title: 'APIキーを保存しました', status: 'success', channel: 'admin' });
        setApiKey(value ?? '');
      } catch (err: any) {
        console.error(err);
        notify({ title: err?.message || '保存に失敗しました', status: 'error', channel: 'admin' });
      } finally {
        setSaving(false);
      }
    },
    [notify],
  );

  const handleSave = () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      notify({ title: 'APIキーを入力してください', status: 'error', channel: 'admin' });
      return;
    }
    if (trimmed.length < MIN_KEY_LENGTH) {
      notify({ title: `APIキーは${MIN_KEY_LENGTH}文字以上で入力してください`, status: 'error', channel: 'admin' });
      return;
    }
    void saveKey(trimmed);
  };

  const handleClear = () => {
    void saveKey(null);
  };

  const handleGenerate = () => {
    setApiKey(buildRandomKey());
  };

  const handleCopyEndpoint = () => {
    if (!info?.endpoint) return;
    navigator.clipboard.writeText(info.endpoint);
    toast({ title: 'エンドポイントをコピーしました', status: 'success', duration: 2000 });
  };

  const handleCopyKey = useCallback(async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      toast({ title: 'APIキーをコピーしました', status: 'success', duration: 2000 });
    } catch (err) {
      console.error(err);
      toast({ title: 'APIキーのコピーに失敗しました', status: 'error', duration: 2000 });
    }
  }, [apiKey, toast]);

  const statusLabel = useMemo(() => {
    if (!info) return '不明';
    return info.is_enabled ? 'APIキー設定済み' : 'APIキー未設定';
  }, [info]);

  if (loading) {
    return (
      <Center py={20}>
        <Spinner color="accent.solid" />
      </Center>
    );
  }

  return (
    <VStack align="stretch" spacing={6} py={6}>
      <Box>
        <Heading size="md" mb={2}>
          患者問診データAPI
        </Heading>
        <Text>
          患者名と生年月日をもとに最新の問診をマークダウン形式で取得できるAPIです。Chrome拡張機能からも利用できます。
        </Text>
        <HStack mt={2} spacing={2} align="center">
          <Badge colorScheme={info?.is_enabled ? 'green' : 'orange'}>{statusLabel}</Badge>
          <Text fontSize="sm" color="fg.muted">
            最終更新: {formatTimestamp(info?.last_updated_at ?? null)}
          </Text>
        </HStack>
      </Box>

      <Stack spacing={4} bg="bg.surface" borderWidth="1px" borderRadius="lg" p={4}>
        <FormControl>
          <FormLabel>APIキー</FormLabel>
          <HStack spacing={2} align="stretch">
            <Input
              type={showApiKey ? 'text' : 'password'}
              autoComplete="new-password"
              value={apiKey}
              placeholder="16文字以上のランダムな文字列"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button size="sm" onClick={handleCopyKey} isDisabled={!apiKey}>
              キーをコピー
            </Button>
          </HStack>
          <HStack mt={2} justify="space-between">
            <Checkbox
              isChecked={showApiKey}
              onChange={(event) => setShowApiKey(event.target.checked)}
            >
              APIキーを表示
            </Checkbox>
          </HStack>
          <FormHelperText>このAPIキーをChrome拡張機能の設定画面に登録してください。</FormHelperText>
        </FormControl>
        <HStack spacing={3} flexWrap="wrap">
          <Button colorScheme="primary" onClick={handleSave} isLoading={saving} loadingText="保存中">
            保存
          </Button>
          <Button variant="outline" onClick={handleClear} isDisabled={saving}>
            登録済みキーを解除
          </Button>
          <Button variant="ghost" onClick={handleGenerate} isDisabled={saving}>
            キーを自動生成
          </Button>
        </HStack>
        <Alert status="info">
          <AlertIcon />
          <AlertDescription>
            APIキーは16文字以上で構成してください。既存のキーを変更すると古いキーは使えなくなります。
          </AlertDescription>
        </Alert>
      </Stack>

      <Stack spacing={3} bg="bg.surface" borderWidth="1px" borderRadius="lg" p={4}>
        <Text fontWeight="bold">API接続情報</Text>
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3}>
          <Box>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              エンドポイント
            </Text>
            <HStack spacing={2} align="center">
              <Code flexGrow={1} whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                {info?.endpoint ?? '未取得'}
              </Code>
              <Button size="sm" onClick={handleCopyEndpoint} variant="outline">
                コピー
              </Button>
            </HStack>
          </Box>
          <Box>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              APIキー送信ヘッダー
            </Text>
            <Code>{info?.header_name ?? '未取得'}</Code>
          </Box>
        </SimpleGrid>
        <Text fontSize="sm" color="fg.muted">
          Chrome拡張機能はこのヘッダーにAPIキーを設定して、エンドポイントを叩きます。
        </Text>
      </Stack>
    </VStack>
  );
}
