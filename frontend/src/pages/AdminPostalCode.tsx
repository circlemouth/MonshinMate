import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  Center,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Input,
  Spinner,
  Stack,
  Text,
  VStack,
} from '@chakra-ui/react';
import { FiUpload } from 'react-icons/fi';
import { useNotify } from '../contexts/NotificationContext';

interface PostalCodeDictionaryInfo {
  is_available: boolean;
  row_count: number;
  source_filename: string | null;
  last_updated_at: string | null;
}

const formatTimestamp = (value: string | null) => {
  if (!value) return '未更新';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('ja-JP');
};

const formatCount = (value: number) => value.toLocaleString('ja-JP');

export default function AdminPostalCode() {
  const { notify } = useNotify();
  const [info, setInfo] = useState<PostalCodeDictionaryInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadInfo = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/system/postal-code-dictionary');
      if (!response.ok) {
        throw new Error('郵便番号辞書の状態を取得できませんでした');
      }
      const data: PostalCodeDictionaryInfo = await response.json();
      setInfo(data);
    } catch (error) {
      console.error(error);
      notify({
        title: error instanceof Error ? error.message : '郵便番号辞書の状態を取得できませんでした',
        status: 'error',
        channel: 'admin',
      });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUploadFile(event.target.files?.[0] ?? null);
  };

  const handleUpload = async () => {
    if (!uploadFile) {
      notify({
        title: 'アップロードするCSVを選択してください',
        status: 'warning',
        channel: 'admin',
      });
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      const response = await fetch('/system/postal-code-dictionary', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || '郵便番号辞書の更新に失敗しました');
      }
      const data: PostalCodeDictionaryInfo = await response.json();
      setInfo(data);
      setUploadFile(null);
      notify({
        title: '郵便番号辞書を更新しました',
        status: 'success',
        channel: 'admin',
      });
    } catch (error) {
      console.error(error);
      notify({
        title: error instanceof Error ? error.message : '郵便番号辞書の更新に失敗しました',
        status: 'error',
        channel: 'admin',
      });
    } finally {
      setUploading(false);
    }
  };

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
          郵便番号辞書
        </Heading>
        <Text color="fg.muted">
          患者用の基本情報入力画面で、郵便番号から住所を自動入力するための辞書を管理します。
        </Text>
      </Box>

      <Stack spacing={4} bg="bg.surface" borderWidth="1px" borderRadius="lg" p={4}>
        <HStack spacing={3} flexWrap="wrap">
          <Badge colorScheme={info?.is_available ? 'green' : 'orange'}>
            {info?.is_available ? '利用可能' : '未登録'}
          </Badge>
          <Text fontSize="sm" color="fg.muted">
            最終更新: {formatTimestamp(info?.last_updated_at ?? null)}
          </Text>
        </HStack>
        <VStack align="stretch" spacing={1}>
          <Text>登録件数: {formatCount(info?.row_count ?? 0)} 件</Text>
          <Text color="fg.muted">元ファイル: {info?.source_filename || '未登録'}</Text>
        </VStack>
      </Stack>

      <Stack spacing={4} bg="bg.surface" borderWidth="1px" borderRadius="lg" p={4}>
        <FormControl>
          <FormLabel>郵便番号対応表CSV</FormLabel>
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            p={1}
            bg="bg.canvas"
          />
          <FormHelperText>
            日本郵便の KEN_ALL 形式のUTF-8 CSVを指定してください。更新後、患者画面の住所自動入力に反映されます。
          </FormHelperText>
        </FormControl>
        <HStack spacing={3} flexWrap="wrap">
          <Button
            colorScheme="primary"
            leftIcon={<FiUpload />}
            onClick={handleUpload}
            isLoading={uploading}
            loadingText="更新中"
          >
            アップロードして更新
          </Button>
          <Button variant="ghost" onClick={loadInfo} isDisabled={uploading}>
            状態を再取得
          </Button>
        </HStack>
        <Alert status="info">
          <AlertIcon />
          <AlertDescription>
            自動入力に失敗した場合でも、患者画面の住所欄は手入力のまま利用できます。
          </AlertDescription>
        </Alert>
      </Stack>
    </VStack>
  );
}
