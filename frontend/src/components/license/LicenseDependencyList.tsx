import { useMemo, useState } from 'react';
import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Icon,
  Input,
  InputGroup,
  InputLeftElement,
  Select,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
  Tooltip,
  Wrap,
  WrapItem,
  useColorModeValue,
  useClipboard,
} from '@chakra-ui/react';
import { SearchIcon, ExternalLinkIcon, CopyIcon, InfoIcon } from '@chakra-ui/icons';
import { LicenseEntry } from '../../types/license';
import {
  detectLicenseTone,
  licenseToneColor,
  resolveLicenseName,
} from '../../utils/license';

export type LicenseDependencyListProps = {
  entries: LicenseEntry[];
  isLoading?: boolean;
  error?: string;
};

export default function LicenseDependencyList({ entries, isLoading, error }: LicenseDependencyListProps) {
  const [keyword, setKeyword] = useState('');
  const [componentFilter, setComponentFilter] = useState('all');
  const [licenseFilter, setLicenseFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [includeDevelopment, setIncludeDevelopment] = useState(false);

  const normalizedEntries = useMemo(() => entries ?? [], [entries]);

  const componentOptions = useMemo(() => {
    return Array.from(new Set(normalizedEntries.map((item) => item.component))).filter(Boolean);
  }, [normalizedEntries]);

  const licenseOptions = useMemo(() => {
    return Array.from(new Set(normalizedEntries.map((item) => resolveLicenseName(item.license)))).filter(Boolean);
  }, [normalizedEntries]);

  const sourceOptions = useMemo(() => {
    return Array.from(new Set(normalizedEntries.map((item) => item.source))).filter(Boolean);
  }, [normalizedEntries]);

  const filteredEntries = useMemo(() => {
    const lowerKeyword = keyword.trim().toLowerCase();
    return normalizedEntries.filter((item) => {
      if (!includeDevelopment && (item.category ?? '').toLowerCase() === 'development') {
        return false;
      }
      if (componentFilter !== 'all' && item.component !== componentFilter) {
        return false;
      }
      if (licenseFilter !== 'all' && resolveLicenseName(item.license) !== licenseFilter) {
        return false;
      }
      if (sourceFilter !== 'all' && item.source !== sourceFilter) {
        return false;
      }
      if (!lowerKeyword) return true;
      const haystack = [item.name, item.version, item.license, item.author ?? '', item.source]
        .join(' ')
        .toLowerCase();
      return haystack.includes(lowerKeyword);
    });
  }, [normalizedEntries, includeDevelopment, componentFilter, licenseFilter, sourceFilter, keyword]);

  const licenseCounts = useMemo(() => {
    const map = new Map<string, number>();
    normalizedEntries.forEach((item) => {
      const name = resolveLicenseName(item.license);
      map.set(name, (map.get(name) ?? 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [normalizedEntries]);

  if (isLoading) {
    return (
      <Flex justify="center" py={10}>
        <Spinner size="lg" />
      </Flex>
    );
  }

  if (error) {
    return (
      <Alert status="error" borderRadius="md">
        <AlertIcon />
        {error}
      </Alert>
    );
  }

  return (
    <Stack spacing={6}>
      <Stack spacing={3}>
        <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} spacing={3}>
          <InputGroup>
            <InputLeftElement pointerEvents="none">
              <SearchIcon color="fg.muted" />
            </InputLeftElement>
            <Input
              placeholder="ライブラリ名・ライセンスで検索"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </InputGroup>
          <Box>
            <Text fontSize="xs" color="fg.muted" mb={1}>
              コンポーネント
            </Text>
            <Select value={componentFilter} onChange={(e) => setComponentFilter(e.target.value)} size="sm">
              <option value="all">すべて</option>
              {componentOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Box>
          <Box>
            <Text fontSize="xs" color="fg.muted" mb={1}>
              ライセンス種別
            </Text>
            <Select value={licenseFilter} onChange={(e) => setLicenseFilter(e.target.value)} size="sm">
              <option value="all">すべて</option>
              {licenseOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Box>
          <Box>
            <Text fontSize="xs" color="fg.muted" mb={1}>
              取得元
            </Text>
            <Select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} size="sm">
              <option value="all">すべて</option>
              {sourceOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Box>
        </SimpleGrid>
        <Checkbox
          isChecked={includeDevelopment}
          onChange={(e) => setIncludeDevelopment(e.target.checked)}
        >
          開発用依存関係も表示する
        </Checkbox>
      </Stack>

      <Wrap spacing={2}>
        {licenseCounts.map(([licenseName, count]) => {
          const tone = detectLicenseTone(licenseName);
          const color = licenseToneColor(tone);
          return (
            <WrapItem key={licenseName}>
              <Badge colorScheme={color} px={2} py={1} borderRadius="md">
                {licenseName} <Text as="span" ml={1}>×{count}</Text>
              </Badge>
            </WrapItem>
          );
        })}
      </Wrap>

      <Accordion allowMultiple borderWidth={0}>
        {filteredEntries.map((item) => (
          <DependencyAccordionItem key={`${item.name}-${item.version}`} item={item} />
        ))}
        {filteredEntries.length === 0 && (
          <Box textAlign="center" py={10} color="fg.muted">
            条件に合致するライブラリがありません。
          </Box>
        )}
      </Accordion>
    </Stack>
  );
}

function DependencyAccordionItem({ item }: { item: LicenseEntry }) {
  const tone = detectLicenseTone(item.license);
  const color = licenseToneColor(tone);
  const { hasCopied, onCopy } = useClipboard(item.text ?? '');
  const licenseName = resolveLicenseName(item.license);
  const panelBg = useColorModeValue('gray.50', 'gray.800');

  return (
    <AccordionItem borderWidth="1px" borderRadius="lg" mb={3} overflow="hidden">
      <h3>
        <AccordionButton _expanded={{ bg: 'bg.subtle' }}>
          <Flex flex="1" align="center" gap={4} textAlign="left">
            <Box>
              <Text fontWeight="semibold">{item.name}</Text>
              <Text fontSize="xs" color="fg.muted">
                v{item.version} / {item.source}
              </Text>
            </Box>
            <Wrap spacing={2} ml="auto">
              <WrapItem>
                <Badge colorScheme={color} variant="subtle">
                  {licenseName}
                </Badge>
              </WrapItem>
              <WrapItem>
                <Badge colorScheme="purple" variant="outline">
                  {item.component}
                </Badge>
              </WrapItem>
              {item.category && (
                <WrapItem>
                  <Badge colorScheme={item.category === 'development' ? 'orange' : 'green'}>
                    {item.category === 'development' ? 'dev' : 'runtime'}
                  </Badge>
                </WrapItem>
              )}
            </Wrap>
          </Flex>
          <AccordionIcon />
        </AccordionButton>
      </h3>
      <AccordionPanel bg={panelBg} px={6} py={5}>
        <Stack spacing={3}>
          <Wrap spacing={3}>
            {item.homepage && (
              <WrapItem>
                <Tooltip label="公式サイトを開く" hasArrow>
                  <Button
                    as="a"
                    href={item.homepage}
                    target="_blank"
                    rel="noreferrer"
                    size="xs"
                    leftIcon={<ExternalLinkIcon />}
                    colorScheme="primary"
                    variant="ghost"
                  >
                    ホームページ
                  </Button>
                </Tooltip>
              </WrapItem>
            )}
            {item.license_url && (
              <WrapItem>
                <Tooltip label="リポジトリ／ライセンス元を開く" hasArrow>
                  <Button
                    as="a"
                    href={item.license_url}
                    target="_blank"
                    rel="noreferrer"
                    size="xs"
                    leftIcon={<ExternalLinkIcon />}
                    variant="ghost"
                  >
                    リポジトリ
                  </Button>
                </Tooltip>
              </WrapItem>
            )}
            <WrapItem>
              <Tooltip label={hasCopied ? 'コピーしました' : '本文をコピー'} hasArrow>
                <Button
                  size="xs"
                  leftIcon={<CopyIcon />}
                  onClick={onCopy}
                  variant="outline"
                >
                  {hasCopied ? 'コピー済み' : '本文をコピー'}
                </Button>
              </Tooltip>
            </WrapItem>
          </Wrap>
          {item.author && (
            <Flex align="center" gap={2} fontSize="sm">
              <Icon as={InfoIcon} color="fg.muted" />
              <Text>作者: {item.author}</Text>
            </Flex>
          )}
          <Box
            as="pre"
            whiteSpace="pre-wrap"
            fontSize="xs"
            bg={useColorModeValue('white', 'gray.900')}
            borderWidth="1px"
            borderRadius="md"
            p={3}
            overflowX="auto"
          >
            {item.text?.trim() || 'ライセンス本文は未登録です。'}
          </Box>
        </Stack>
      </AccordionPanel>
    </AccordionItem>
  );
}
