import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  Heading,
  HStack,
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

const formatTimestamp = (value: string | null) => {
  if (!value) return '未設定';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('ja-JP');
};

export default function AdminApi() {
  const [info, setInfo] = useState<PatientSummaryApiInfo | null>(null);
  const [loading, setLoading] = useState(true);
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

  const handleCopyEndpoint = () => {
    if (!info?.endpoint) return;
    navigator.clipboard.writeText(info.endpoint);
    toast({ title: 'エンドポイントをコピーしました', status: 'success', duration: 2000 });
  };

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
          APIキーはSecret Managerで管理します。画面から表示、生成、変更はできません。
        </Text>
      </Stack>
    </VStack>
  );
}
