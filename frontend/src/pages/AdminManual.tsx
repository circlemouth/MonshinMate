import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Center,
  Heading,
  Spinner,
  Stack,
  Text,
  useColorModeValue,
} from '@chakra-ui/react';
import { RepeatIcon } from '@chakra-ui/icons';

const manualPath = '/docs/admin_user_manual.md';

function mdToHtml(md: string) {
  const lines = md.split(/\r?\n/);
  const html: string[] = [];
  let inUl = false;
  let inOl = false;

  const flushLists = () => {
    if (inUl) {
      html.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      html.push('</ol>');
      inOl = false;
    }
  };

  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const inline = (s: string) => {
    let value = s;
    value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return value;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushLists();
      html.push('');
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushLists();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
      continue;
    }

    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (inOl) {
        html.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        html.push('<ul>');
        inUl = true;
      }
      html.push(`<li>${inline(esc(ul[1]))}</li>`);
      continue;
    }

    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (inUl) {
        html.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        html.push('<ol>');
        inOl = true;
      }
      html.push(`<li>${inline(esc(ol[1]))}</li>`);
      continue;
    }

    flushLists();
    html.push(`<p>${inline(esc(line))}</p>`);
  }

  flushLists();
  return html.join('\n');
}

/**
 * 管理画面の使い方を説明するユーザー向けドキュメント
 * （docs/admin_user_manual.md）の内容を表示するページ。
 */
export default function AdminManual() {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const cardBg = useColorModeValue('white', 'gray.900');
  const inlineCodeBg = useColorModeValue('gray.50', 'gray.800');

  const loadManual = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(manualPath, { cache: 'no-store', signal });
        if (!response.ok) {
          throw new Error('failed');
        }
        const text = await response.text();
        setContent(text);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setError('ドキュメントの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    loadManual(controller.signal);
    return () => controller.abort();
  }, [loadManual]);

  const html = useMemo(() => (content ? mdToHtml(content) : ''), [content]);

  return (
    <Stack spacing={6} align="stretch">
      <Stack spacing={1}>
        <Heading size="lg">システム説明</Heading>
        <Text fontSize="sm" color="fg.muted">
          MonshinMate 管理画面の操作方法や手順をまとめたドキュメントです。
        </Text>
      </Stack>

      {error && (
        <Alert status="error" variant="subtle" borderRadius="md" alignItems="flex-start">
          <AlertIcon />
          <Stack spacing={1} flex="1">
            <Text fontWeight="semibold">{error}</Text>
            <Text fontSize="sm">通信環境を確認し、再読み込みをお試しください。</Text>
          </Stack>
          <Button
            size="sm"
            variant="outline"
            leftIcon={<RepeatIcon />}
            onClick={() => loadManual()}
            isLoading={loading}
          >
            再読み込み
          </Button>
        </Alert>
      )}

      <Card variant="outline" bg={cardBg} borderRadius="lg" borderWidth="1px">
        <CardHeader pb={2}>
          <Stack
            direction={{ base: 'column', md: 'row' }}
            align={{ base: 'flex-start', md: 'center' }}
            justify="space-between"
            spacing={3}
          >
            <Box>
              <Heading size="md">管理画面 操作ガイド</Heading>
              <Text fontSize="sm" color="fg.muted">
                管理業務に必要な操作手順と注意点をまとめたドキュメントです。
              </Text>
            </Box>
          </Stack>
        </CardHeader>
        <CardBody>
          {loading && !html && (
            <Center py={16}>
              <Spinner size="lg" color="primary.500" thickness="3px" speed="0.65s" />
            </Center>
          )}

          {!loading && !html && !error && (
            <Text fontSize="sm" color="fg.muted">
              ドキュメントに表示できる内容が見つかりませんでした。
            </Text>
          )}

          {html && (
            <Box
              fontSize="sm"
              lineHeight="1.8"
              sx={{
                'h1': { fontSize: 'xl', fontWeight: 'bold', mt: 8, mb: 4 },
                'h2': { fontSize: 'lg', fontWeight: 'bold', mt: 6, mb: 3 },
                'h3': { fontSize: 'md', fontWeight: 'semibold', mt: 4, mb: 2 },
                'h4': { fontSize: 'sm', fontWeight: 'semibold', mt: 4, mb: 2 },
                'p': { mb: 3, color: 'fg.default' },
                'ul': { pl: 5, mb: 3, listStyleType: 'disc' },
                'ol': { pl: 5, mb: 3 },
                'li': { mb: 1 },
                'a': { color: 'primary.600', textDecoration: 'underline', fontWeight: 'medium' },
                'code': {
                  bg: inlineCodeBg,
                  px: 1.5,
                  py: 0.5,
                  borderRadius: 'sm',
                  fontFamily: 'mono',
                  fontSize: '0.85em',
                },
                'strong': { fontWeight: 'semibold' },
                'em': { fontStyle: 'italic' },
              }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {loading && html && (
            <Stack direction="row" align="center" spacing={2} mt={6} color="fg.muted">
              <Spinner size="sm" />
              <Text fontSize="xs">最新の内容を読み込み中です…</Text>
            </Stack>
          )}
        </CardBody>
      </Card>
    </Stack>
  );
}
