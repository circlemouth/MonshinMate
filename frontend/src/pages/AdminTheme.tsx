import { useState, useEffect } from 'react';
import {
  VStack,
  HStack,
  Box,
  Button,
  Input,
  Text,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverArrow,
  PopoverCloseButton,
  PopoverBody,
  useDisclosure,
} from '@chakra-ui/react';
import { AddIcon } from '@chakra-ui/icons';
import { useThemeColor } from '../contexts/ThemeColorContext';

const samples = [
  '#D32F2F', // Red
  '#F57C00', // Orange
  '#FBC02D', // Yellow
  '#388E3C', // Green
  '#1976D2', // Blue
  '#00796B', // Teal
  '#7B1FA2', // Purple
  '#C2185B', // Pink
  '#5D4037', // Brown
  '#455A64', // Blue Grey
];

const defaultCustomColor = '#000000';

function getContrastingIconColor(hex: string): 'black' | 'white' {
  if (!hex || hex.length < 7) return 'black';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? 'black' : 'white';
}

/** テーマカラー設定画面。 */
export default function AdminTheme() {
  const { color, setColor } = useThemeColor();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [selected, setSelected] = useState(color);
  const [isCustom, setIsCustom] = useState(false);
  const [customColor, setCustomColor] = useState(defaultCustomColor);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const isPreset = samples.includes(color);
    setSelected(color);
    setIsCustom(!isPreset);
    if (!isPreset) {
      setCustomColor(color);
    }
  }, [color]);

  const selectPreset = (c: string) => {
    setSelected(c);
    setIsCustom(false);
    onClose();
  };

  const handlePopoverOpen = () => {
    setSelected(customColor);
    setIsCustom(true);
    onOpen();
  };

  const onCustomChange = (e: any) => {
    const newColor = e.target.value;
    setSelected(newColor);
    setCustomColor(newColor);
  };

  const save = async () => {
    setStatus('');
    try {
      const res = await fetch('/system/theme-color', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: selected || '#1976D2' }),
      });
      if (!res.ok) throw new Error('save_failed');
      const d = await res.json();
      setColor(d.color);
      setStatus('保存しました');
      onClose();
    } catch (e) {
      setStatus('保存に失敗しました');
    }
  };

  const customButtonIconColor = getContrastingIconColor(customColor);

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
            border={selected === c && !isCustom ? '2px solid black' : '1px solid #ccc'}
            onClick={() => selectPreset(c)}
          />
        ))}
        <Popover isOpen={isOpen} onOpen={handlePopoverOpen} onClose={onClose} placement="bottom">
          <PopoverTrigger>
            <Box
              as="button"
              w="24px"
              h="24px"
              borderRadius="full"
              bg={customColor}
              border={isCustom ? '2px solid black' : '1px solid #ccc'}
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <AddIcon w="12px" h="12px" color={customButtonIconColor} />
            </Box>
          </PopoverTrigger>
          <PopoverContent w="auto">
            <PopoverArrow />
            <PopoverCloseButton />
            <PopoverBody>
              <HStack>
                <Input
                  value={selected}
                  onChange={onCustomChange}
                  placeholder="#RRGGBB"
                  maxW="150px"
                />
                <Input type="color" value={selected} onChange={onCustomChange} maxW="60px" p={0} />
              </HStack>
            </PopoverBody>
          </PopoverContent>
        </Popover>
      </HStack>
      <HStack>
        <Button onClick={save} colorScheme="primary">保存</Button>
        <Text>{status}</Text>
      </HStack>
    </VStack>
  );
}