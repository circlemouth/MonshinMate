import { useState, useEffect } from 'react';
import { VStack, HStack, Box, Button, Input, Text } from '@chakra-ui/react';
import { useThemeColor } from '../contexts/ThemeColorContext';

const samples = [
  '#FFB3BA',
  '#FFDFBA',
  '#FFFFBA',
  '#BAFFC9',
  '#BAE1FF',
  '#E2F0CB',
  '#FF9AA2',
  '#C7CEEA',
  '#F1CBFF',
  '#FFEFD5',
];

/** テーマカラー設定画面。 */
export default function AdminTheme() {
  const { color, setColor } = useThemeColor();
  const [selected, setSelected] = useState(color);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setSelected(color);
  }, [color]);

  const select = (c: string) => {
    setSelected(c);
  };

  const onCustomChange = (e: any) => {
    const val = e.target.value;
    setSelected(val);
  };

  const save = async () => {
    setStatus('');
    try {
      const res = await fetch('/system/theme-color', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: selected || '#1e88e5' }),
      });
      if (!res.ok) throw new Error('save_failed');
      const d = await res.json();
      setColor(d.color);
      setStatus('保存しました');
    } catch (e) {
      setStatus('保存に失敗しました');
    }
  };

  return (
    <VStack spacing={4} align="stretch">
      <Text>テーマカラーを選択してください。</Text>
      <HStack>
        {samples.map((c) => (
          <Box
            key={c}
            as="button"
            w="24px"
            h="24px"
            borderRadius="full"
            bg={c}
            border={selected === c ? '2px solid black' : '1px solid #ccc'}
            onClick={() => select(c)}
          />
        ))}
      </HStack>
      <HStack>
        <Input value={selected} onChange={onCustomChange} placeholder="#RRGGBB" maxW="150px" />
        <Input type="color" value={selected} onChange={onCustomChange} maxW="60px" p={0} />
      </HStack>
      <HStack>
        <Button onClick={save} colorScheme="primary">保存</Button>
        <Text>{status}</Text>
      </HStack>
    </VStack>
  );
}
