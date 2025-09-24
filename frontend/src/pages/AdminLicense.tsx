import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Flex,
  Heading,
  Icon,
  Spinner,
  Stack,
  Stat,
  StatHelpText,
  StatLabel,
  StatNumber,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Tooltip,
  useClipboard,
  useColorModeValue,
  Wrap,
  WrapItem,
} from '@chakra-ui/react';
import { CheckCircleIcon, DownloadIcon, WarningIcon } from '@chakra-ui/icons';
import LicenseDependencyList from '../components/license/LicenseDependencyList';
import { detectLicenseTone, fetchDependencyLicenses, licenseToneColor } from '../utils/license';
import { LicenseEntry, LicenseTone } from '../types/license';

export default function AdminLicense() {
  const [licenseText, setLicenseText] = useState('');
  const [licenseError, setLicenseError] = useState('');
  const [licenseLoading, setLicenseLoading] = useState(true);

  const [dependencies, setDependencies] = useState<LicenseEntry[]>([]);
  const [depsError, setDepsError] = useState('');
  const [depsLoading, setDepsLoading] = useState(true);

  useEffect(() => {
    setLicenseLoading(true);
    fetch('/LICENSE', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.text();
      })
      .then((text) => setLicenseText(text))
      .catch(() => setLicenseError('ライセンス本文の取得に失敗しました'))
      .finally(() => setLicenseLoading(false));
  }, []);

  useEffect(() => {
    setDepsLoading(true);
    fetchDependencyLicenses()
      .then((entries) => setDependencies(entries))
      .catch(() => setDepsError('依存ライブラリのライセンス情報の取得に失敗しました'))
      .finally(() => setDepsLoading(false));
  }, []);

  const summary = useMemo(() => buildLicenseSummary(licenseText), [licenseText]);
  const stats = useMemo(() => summarizeDependencies(dependencies), [dependencies]);
  const { hasCopied: licenseCopied, onCopy: copyLicense } = useClipboard(licenseText ?? '');

  const licenseHtml = useMemo(() => mdToHtml(licenseText), [licenseText]);
  const licensePanelBg = useColorModeValue('white', 'gray.900');

  return (
    <Stack spacing={6}>
      <Heading size="lg">ライセンス情報</Heading>
      <Tabs colorScheme="primary" variant="enclosed-colored">
        <TabList overflowX="auto">
          <Tab>概要</Tab>
          <Tab>本体ライセンス全文</Tab>
          <Tab>依存ライブラリ</Tab>
        </TabList>
        <TabPanels mt={4}>
          <TabPanel px={0}>
            <Stack spacing={6}>
              <Card variant="outline">
                <CardHeader>
                  <Flex justify="space-between" align={{ base: 'flex-start', md: 'center' }} gap={4}>
                    <Box>
                      <Heading size="md">MonshinMate ライセンス概要</Heading>
                      <Text fontSize="sm" color="fg.muted">
                        リポジトリ全体に適用される基本ライセンスの要約です。
                      </Text>
                    </Box>
                    <Badge colorScheme={licenseToneColor(summary.tone)} px={3} py={1} borderRadius="md">
                      {summary.name}
                    </Badge>
                  </Flex>
                </CardHeader>
                <CardBody>
                  <Stack spacing={5}>
                    <Text>{summary.description}</Text>
                    <Wrap spacing={4}>
                      {summary.highlights.map((item) => (
                        <WrapItem key={item.label}>
                          <Box borderWidth="1px" borderRadius="md" px={3} py={2} minW="180px">
                            <Text fontSize="xs" color="fg.muted">
                              {item.label}
                            </Text>
                            <Text fontWeight="semibold">{item.value}</Text>
                          </Box>
                        </WrapItem>
                      ))}
                    </Wrap>
                    <Flex gap={3} wrap="wrap">
                      <Button
                        as="a"
                        href="/LICENSE"
                        target="_blank"
                        rel="noreferrer"
                        leftIcon={<DownloadIcon />}
                        size="sm"
                        colorScheme="primary"
                        variant="solid"
                      >
                        ライセンス全文をダウンロード
                      </Button>
                      <Tooltip label={licenseCopied ? 'コピーしました' : '全文をクリップボードへコピー'}>
                        <Button size="sm" variant="outline" onClick={copyLicense}>
                          {licenseCopied ? 'コピー済み' : '全文をコピー'}
                        </Button>
                      </Tooltip>
                    </Flex>
                  </Stack>
                </CardBody>
              </Card>

              <Card variant="outline">
                <CardHeader>
                  <Heading size="sm">遵守事項チェックリスト</Heading>
                </CardHeader>
                <CardBody>
                  <Stack spacing={4}>
                    {summary.obligations.map((item) => (
                      <Flex key={item.title} align="flex-start" gap={3}>
                        <Icon
                          as={item.severity === 'must' ? CheckCircleIcon : WarningIcon}
                          color={item.severity === 'must' ? 'green.500' : 'orange.400'}
                          boxSize={5}
                          mt={1}
                        />
                        <Box>
                          <Text fontWeight="semibold">{item.title}</Text>
                          <Text fontSize="sm" color="fg.muted">
                            {item.detail}
                          </Text>
                        </Box>
                      </Flex>
                    ))}
                  </Stack>
                </CardBody>
              </Card>

              <Card variant="outline">
                <CardHeader>
                  <Heading size="sm">依存ライブラリの状況</Heading>
                </CardHeader>
                <CardBody>
                  <Stack spacing={4}>
                    <Flex gap={6} wrap="wrap">
                      <Stat minW="160px">
                        <StatLabel>総ライブラリ数</StatLabel>
                        <StatNumber>{stats.total}</StatNumber>
                        <StatHelpText>うち開発用 {stats.development}</StatHelpText>
                      </Stat>
                      <Stat minW="160px">
                        <StatLabel>バックエンド / フロント</StatLabel>
                        <StatNumber>
                          {stats.backend} / {stats.frontend}
                        </StatNumber>
                        <StatHelpText>カテゴリ: {stats.runtime} runtime</StatHelpText>
                      </Stat>
                      <Stat minW="160px">
                        <StatLabel>コピーレフト系</StatLabel>
                        <StatNumber>{stats.copyleft}</StatNumber>
                        <StatHelpText>強い: {stats.strongCopyleft}, 緩やか: {stats.weakCopyleft}</StatHelpText>
                      </Stat>
                    </Flex>
                    <Divider />
                    <Text fontSize="sm" color="fg.muted">
                      依存ライブラリ個々のライセンス本文や統計の詳細は「依存ライブラリ」タブをご参照ください。
                    </Text>
                  </Stack>
                </CardBody>
              </Card>
            </Stack>
          </TabPanel>

          <TabPanel px={{ base: 0, md: 2 }}>
            {licenseLoading ? (
              <Flex justify="center" py={10}>
                <Spinner size="lg" />
              </Flex>
            ) : licenseError ? (
              <Box color="red.500" fontSize="sm">
                {licenseError}
              </Box>
            ) : (
              <Box
                borderWidth="1px"
                borderRadius="lg"
                p={6}
                bg={licensePanelBg}
                maxH="70vh"
                overflowY="auto"
                fontSize="sm"
                sx={{
                  'h1': { fontSize: 'xl', fontWeight: 'bold', mt: 4, mb: 2 },
                  'h2': { fontSize: 'lg', fontWeight: 'bold', mt: 4, mb: 2 },
                  'h3': { fontSize: 'md', fontWeight: 'semibold', mt: 3, mb: 2 },
                  'p': { mb: 2, lineHeight: 1.7 },
                  'ul': { pl: 6, mb: 2, listStyleType: 'disc' },
                  'ol': { pl: 6, mb: 2 },
                  'li': { mb: 1 },
                  'code': { bg: 'gray.50', px: 1, borderRadius: 'sm', fontFamily: 'monospace' },
                  'a': { color: 'primary.600', textDecoration: 'underline' },
                }}
                dangerouslySetInnerHTML={{ __html: licenseHtml }}
              />
            )}
          </TabPanel>

          <TabPanel px={0}>
            <LicenseDependencyList entries={dependencies} isLoading={depsLoading} error={depsError} />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Stack>
  );
}

type LicenseObligation = {
  title: string;
  detail: string;
  severity: 'must' | 'should';
};

type LicenseSummary = {
  name: string;
  tone: LicenseTone;
  description: string;
  highlights: { label: string; value: string }[];
  obligations: LicenseObligation[];
};

function buildLicenseSummary(text: string): LicenseSummary {
  if (!text) {
    return {
      name: 'ライセンス未取得',
      tone: 'unknown',
      description: 'ライセンス本文がまだ取得できていません。`LICENSE` ファイルが配置されているかを確認してください。',
      highlights: [
        { label: '再配布', value: '要確認' },
        { label: '改変・派生', value: '要確認' },
        { label: '商用利用', value: '要確認' },
      ],
      obligations: [
        {
          title: 'ライセンスファイルの配置',
          detail: 'リポジトリ直下に LICENSE を配置し、アプリケーション配布物にも同梱してください。',
          severity: 'must',
        },
      ],
    };
  }

  const normalized = text.toLowerCase();
  if (normalized.includes('gnu general public license') && normalized.includes('version 3')) {
    return {
      name: 'GNU General Public License v3.0',
      tone: 'strong-copyleft',
      description:
        'MonshinMate は GPLv3 で公開されています。配布物や派生物を提供する場合は、ソースコードの開示と同一ライセンスでの再配布が必要です。',
      highlights: [
        { label: '再配布', value: 'GPLv3／互換ライセンスでの公開が必須' },
        { label: '商用利用', value: '可能（GPLv3順守が条件）' },
        { label: '改変コード', value: '変更点の開示が必要' },
      ],
      obligations: [
        {
          title: 'ソースコード開示',
          detail: 'バイナリ配布やクラウド提供を行う場合も、利用者がソースコードを入手できるよう体制を整備してください。',
          severity: 'must',
        },
        {
          title: 'ライセンス全文・著作権表示の同梱',
          detail: '配布物には GPLv3 の全文と著作権表記（コピーライト・免責事項）をそのまま同梱する必要があります。',
          severity: 'must',
        },
        {
          title: '派生物の GPLv3 継承',
          detail: 'MonshinMate を基にした派生モジュール・プラグインも GPLv3 互換ライセンスで公開してください。',
          severity: 'must',
        },
        {
          title: '第三者ライブラリのライセンス遵守',
          detail: '依存パッケージのライセンス条項（特に MIT/BSD/Apache などの著作権表示）を配布物に残す必要があります。',
          severity: 'should',
        },
      ],
    };
  }

  if (normalized.includes('mit license')) {
    return {
      name: 'MIT License',
      tone: 'permissive',
      description:
        'MonshinMate は MIT ライセンスで提供されています。再配布・商用利用は自由ですが、著作権表示と免責事項を残す必要があります。',
      highlights: [
        { label: '再配布', value: '制限なし（著作権表示の保持が条件）' },
        { label: '商用利用', value: '可能' },
        { label: '改変コード', value: '公開義務なし' },
      ],
      obligations: [
        {
          title: '著作権表示・免責声明の保持',
          detail: 'オリジナルの著作権表示と免責声明を配布物に残してください。',
          severity: 'must',
        },
        {
          title: 'ライセンス本文の同梱',
          detail: 'バイナリ配布時も MIT License の全文を添付することが推奨されます。',
          severity: 'should',
        },
      ],
    };
  }

  return {
    name: '不明なライセンス',
    tone: 'unknown',
    description:
      'ライセンスの種類を自動判別できませんでした。手動で内容を確認し、再配布条件を整理してください。',
    highlights: [
      { label: '再配布', value: '内容に応じて確認が必要' },
      { label: '商用利用', value: '内容に応じて確認が必要' },
      { label: '改変コード', value: '内容に応じて確認が必要' },
    ],
    obligations: [
      {
        title: 'ライセンス整備',
        detail: 'プロジェクトのライセンス条項を決定し、`LICENSE` ファイルに明文化してください。',
        severity: 'must',
      },
    ],
  };
}

type DependencyStats = {
  total: number;
  runtime: number;
  development: number;
  backend: number;
  frontend: number;
  copyleft: number;
  strongCopyleft: number;
  weakCopyleft: number;
};

function summarizeDependencies(entries: LicenseEntry[]): DependencyStats {
  if (!entries.length) {
    return {
      total: 0,
      runtime: 0,
      development: 0,
      backend: 0,
      frontend: 0,
      copyleft: 0,
      strongCopyleft: 0,
      weakCopyleft: 0,
    };
  }

  let runtime = 0;
  let development = 0;
  let backend = 0;
  let frontend = 0;
  let strongCopyleft = 0;
  let weakCopyleft = 0;

  entries.forEach((entry) => {
    if ((entry.category ?? '').toLowerCase() === 'development') {
      development += 1;
    } else {
      runtime += 1;
    }

    if (entry.component === 'frontend') {
      frontend += 1;
    } else if (entry.component === 'backend') {
      backend += 1;
    }

    const tone = detectLicenseTone(entry.license);
    if (tone === 'strong-copyleft') {
      strongCopyleft += 1;
    } else if (tone === 'weak-copyleft') {
      weakCopyleft += 1;
    }
  });

  return {
    total: entries.length,
    runtime,
    development,
    backend,
    frontend,
    copyleft: strongCopyleft + weakCopyleft,
    strongCopyleft,
    weakCopyleft,
  };
}

function mdToHtml(md: string): string {
  if (!md) return '';
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
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => {
    let result = s;
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return result;
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
