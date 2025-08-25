import { useEffect, useState } from 'react';
import {
  VStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  HStack,
  Text,
  Textarea,
  Box,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverArrow,
  PopoverCloseButton,
  PopoverBody,
  useDisclosure,
  Heading,
  Divider,
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

/** システムの外観（表示名・テーマカラー）を設定する画面。 */
export default function AdminAppearance() {
  // System Name states
  const [name, setName] = useState('');
  const [completionMessage, setCompletionMessage] = useState('ご回答ありがとうございました。');
  const [entryMessage, setEntryMessage] = useState('不明点があれば受付にお知らせください'); // New state

  // Theme states
  const { color, setColor } = useThemeColor();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [selectedColor, setSelectedColor] = useState(color);
  const [isCustom, setIsCustom] = useState(false);
  const [customColor, setCustomColor] = useState(defaultCustomColor);

  // Common states
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 表示名・完了メッセージを取得
    fetch('/system/display-name')
      .then((r) => r.json())
      .then((d) => setName(d.display_name || 'Monshinクリニック'));
    fetch('/system/completion-message')
      .then((r) => r.json())
      .then((d) => setCompletionMessage(d.message || 'ご回答ありがとうございました。'));
    fetch('/system/entry-message') // New fetch
      .then((r) => r.json())
      .then((d) => setEntryMessage(d.message || '不明点があれば受付にお知らせください'));

    // テーマカラーを初期化
    const isPreset = samples.includes(color);
    setSelectedColor(color);
    setIsCustom(!isPreset);
    if (!isPreset) {
      setCustomColor(color);
    }
  }, [color]);

  const selectPreset = (c: string) => {
    setSelectedColor(c);
    setIsCustom(false);
    onClose();
  };

  const handlePopoverOpen = () => {
    setSelectedColor(customColor);
    setIsCustom(true);
    onOpen();
  };

  const onCustomChange = (e: any) => {
    const newColor = e.target.value;
    setSelectedColor(newColor);
    setCustomColor(newColor);
  };

  const save = async () => {
    setLoading(true);
    setStatus('');
    try {
      // 表示名と完了メッセージを保存
      const resName = await fetch('/system/display-name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name || 'Monshinクリニック' }),
      });
      if (!resName.ok) throw new Error('表示名の保存に失敗しました');
      const dataName = await resName.json();
      setName(dataName.display_name || 'Monshinクリニック');
      window.dispatchEvent(new CustomEvent('systemDisplayNameUpdated', { detail: dataName.display_name }));

      const resMsg = await fetch('/system/completion-message', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: completionMessage || 'ご回答ありがとうございました。' }),
      });
      if (!resMsg.ok) throw new Error('完了メッセージの保存に失敗しました');
      const dataMsg = await resMsg.json();
      setCompletionMessage(dataMsg.message || 'ご回答ありがとうございました。');

      // New fetch for entry message
      const resEntryMsg = await fetch('/system/entry-message', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: entryMessage || '不明点があれば受付にお知らせください' }),
      });
      if (!resEntryMsg.ok) throw new Error('問診開始画面メッセージの保存に失敗しました');
      const dataEntryMsg = await resEntryMsg.json();
      setEntryMessage(dataEntryMsg.message || '不明点があれば受付にお知らせください');

      // テーマカラーを保存
      const resTheme = await fetch('/system/theme-color', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: selectedColor || '#1976D2' }),
      });
      if (!resTheme.ok) throw new Error('テーマカラーの保存に失敗しました');
      const dataTheme = await resTheme.json();
      setColor(dataTheme.color);

      setStatus('保存しました');
      onClose();
    } catch (e: any) {
      setStatus(e.message || '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const customButtonIconColor = getContrastingIconColor(customColor);

  return (
    <VStack spacing={6} align="stretch">
      <Heading size="md">表示設定</Heading>

      {/* 表示設定 */}
      <VStack spacing={4} align="stretch">
        <FormControl>
          <FormLabel>システム表示名</FormLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例: Monshinクリニック" />
        </FormControl>
        <FormControl>
          <FormLabel>完了画面のメッセージ</FormLabel>
          <Textarea
            value={completionMessage}
            onChange={(e) => setCompletionMessage(e.target.value)}
            placeholder="例: ご回答ありがとうございました。"
          />
        </FormControl>
        <FormControl> {/* New FormControl */}
          <FormLabel>問診開始画面のメッセージ</FormLabel>
          <Textarea
            value={entryMessage}
            onChange={(e) => setEntryMessage(e.target.value)}
            placeholder="例: 不明点があれば受付にお知らせください"
          />
        </FormControl>
      </VStack>

      <Divider />

      {/* テーマカラー設定 */}
      <VStack spacing={4} align="stretch">
        <FormControl>
          <FormLabel>テーマカラー</FormLabel>
          <HStack>
            {samples.map((c) => (
              <Box
                key={c}
                as="button"
                w="24px"
                h="24px"
                borderRadius="full"
                bg={c}
                border={selectedColor === c && !isCustom ? '2px solid black' : '1px solid #ccc'}
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
                      value={selectedColor}
                      onChange={onCustomChange}
                      placeholder="#RRGGBB"
                      maxW="150px"
                    />
                    <Input type="color" value={selectedColor} onChange={onCustomChange} maxW="60px" p={0} />
                  </HStack>
                </PopoverBody>
              </PopoverContent>
            </Popover>
          </HStack>
        </FormControl>
      </VStack>

      <Divider />

      <HStack>
        <Button onClick={save} colorScheme="primary" isLoading={loading}>
          保存
        </Button>
        <Text>{status}</Text>
      </HStack>
    </VStack>
  );
}
