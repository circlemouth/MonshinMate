import { useEffect, useState } from 'react';
import { VStack, SimpleGrid, Box, Button, Text } from '@chakra-ui/react';
import { useThemeColor } from '../contexts/ThemeContext';
import { themePalettes, themeLabels, ThemeName } from '../theme/palettes';

/** テーマカラーの設定画面。 */
export default function AdminTheme() {
  const { theme, setTheme } = useThemeColor();
  const [selected, setSelected] = useState<ThemeName>(theme);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => setSelected(theme), [theme]);

  const save = async () => {
    setLoading(true);
    setStatus('');
    try {
      const res = await fetch('/system/theme-color', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: selected }),
      });
      if (!res.ok) throw new Error('save_failed');
      setTheme(selected);
      setStatus('保存しました');
    } catch (e) {
      setStatus('保存に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <VStack align="stretch" spacing={4}>
      <Text>テーマカラーを選択してください。</Text>
      <SimpleGrid columns={{ base: 2, md: 5 }} spacing={4}>
        {Object.entries(themePalettes).map(([name, palette]) => {
          const key = name as ThemeName;
          const active = selected === key;
          return (
            <Box
              key={name}
              borderWidth={active ? '2px' : '1px'}
              borderColor={active ? 'primary.700' : 'gray.300'}
              borderRadius="md"
              overflow="hidden"
              cursor="pointer"
              onClick={() => setSelected(key)}
            >
              <Box h="40px" bg={palette[500]} />
              <Box h="20px" bg={palette[200]} />
              <Box h="20px" bg="white" borderTopWidth="1px" borderColor="gray.100" />
              <Text fontSize="sm" textAlign="center" py={1}>
                {themeLabels[key]}
              </Text>
            </Box>
          );
        })}
      </SimpleGrid>
      <Button onClick={save} colorScheme="primary" isLoading={loading}>
        保存
      </Button>
      {status && <Text>{status}</Text>}
    </VStack>
  );
}
