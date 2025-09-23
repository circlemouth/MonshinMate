import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  VStack,
  Stack,
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
  Wrap,
  WrapItem,
  Tooltip,
  IconButton,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  useToast,
} from '@chakra-ui/react';
import { AddIcon, CheckIcon } from '@chakra-ui/icons';
import { useThemeColor } from '../contexts/ThemeColorContext';

const colorPresets = [
  { value: '#D32F2F', label: 'レッド' },
  { value: '#F57C00', label: 'オレンジ' },
  { value: '#FBC02D', label: 'イエロー' },
  { value: '#388E3C', label: 'グリーン' },
  { value: '#1976D2', label: 'ブルー' },
  { value: '#00796B', label: 'ティール' },
  { value: '#7B1FA2', label: 'パープル' },
  { value: '#C2185B', label: 'ピンク' },
  { value: '#5D4037', label: 'ブラウン' },
  { value: '#455A64', label: 'ブルーグレー' },
];

const presetValues = colorPresets.map((preset) => preset.value);

const defaultCustomColor = '#000000';

function getContrastingIconColor(hex: string): 'black' | 'white' {
  if (!hex || hex.length < 7) return 'black';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? 'black' : 'white';
}

function Section({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card variant="outline">
      <CardHeader>
        <Stack spacing={1} align="flex-start">
          <Heading size="md">{title}</Heading>
          {description && (
            <Text fontSize="sm" color="fg.muted">
              {description}
            </Text>
          )}
        </Stack>
      </CardHeader>
      <CardBody>
        <Stack spacing={4} align="stretch">
          {children}
        </Stack>
      </CardBody>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
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
  const toast = useToast();
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // Logo states
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 1, h: 1 });
  type DragMode = 'none' | 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';
  const [dragMode, setDragMode] = useState<DragMode>('none');
  const dragStartRef = useRef<{ px: number; py: number; crop: { x: number; y: number; w: number; h: number } } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

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
    const isPreset = presetValues.includes(color);
    setSelectedColor(color);
    setIsCustom(!isPreset);
    if (!isPreset) {
      setCustomColor(color);
    }
  }, [color]);

  // Load logo settings
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/system/logo');
        if (r.ok) {
          const d = await r.json();
          if (d?.url) setLogoUrl(d.url);
          if (d?.crop) setCrop({ x: d.crop.x ?? 0, y: d.crop.y ?? 0, w: d.crop.w ?? 1, h: d.crop.h ?? 1 });
        }
      } catch {}
    })();
  }, []);

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
    setStatus(null);
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

      // Save logo settings (if any)
      await fetch('/system/logo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: logoUrl, crop }),
      });
      try { window.dispatchEvent(new CustomEvent('systemLogoUpdated', { detail: { url: logoUrl, crop } })); } catch {}

      setStatus({ type: 'success', message: '保存しました' });
      toast({
        title: '外観設定を保存しました',
        status: 'success',
        duration: 3000,
        isClosable: true,
        position: 'top-right',
      });
      onClose();
    } catch (e: any) {
      console.error(e);
      const message = e?.message || '保存に失敗しました';
      setStatus({ type: 'error', message });
      toast({
        title: '保存に失敗しました',
        description: message,
        status: 'error',
        duration: 4000,
        isClosable: true,
        position: 'top-right',
      });
    } finally {
      setLoading(false);
    }
  };

  const customButtonIconColor = getContrastingIconColor(customColor);

  const iconPreview = useMemo(() => {
    if (!logoUrl) {
      return (
        <Box
          w="64px"
          h="64px"
          borderRadius="full"
          bg="gray.100"
          _dark={{ bg: 'gray.600' }}
          display="flex"
          alignItems="center"
          justifyContent="center"
          color="fg.muted"
          fontSize="xs"
          fontWeight="semibold"
        >
          NO LOGO
        </Box>
      );
    }
    const x = crop.x ?? 0;
    const y = crop.y ?? 0;
    const w = crop.w || 1;
    const transform = `translate(${-x * 100}%, ${-y * 100}%) scale(${1 / (w || 1)})`;
    return (
      <Box
        w="64px"
        h="64px"
        borderRadius="full"
        overflow="hidden"
        bg="gray.100"
        _dark={{ bg: 'gray.600' }}
        position="relative"
      >
        <img
          src={logoUrl}
          alt="logo preview"
          style={{ width: '100%', height: 'auto', transform, transformOrigin: 'top left', display: 'block' }}
        />
      </Box>
    );
  }, [logoUrl, crop]);

  const uploadLogo = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const defaultCrop = { x: 0, y: 0, w: 1, h: 1 };
    try {
      const r = await fetch('/system-logo', { method: 'POST', body: fd });
      if (!r.ok) {
        let detail: string | undefined;
        try {
          const payload = await r.json();
          detail = typeof payload?.detail === 'string' ? payload.detail : undefined;
        } catch {
          detail = undefined;
        }
        throw new Error(detail || 'ロゴ画像のアップロードに失敗しました。別の画像でお試しください。');
      }
      const d = await r.json();
      const url = d.url as string;
      setLogoUrl(url);
      setCrop(defaultCrop);
      await fetch('/system/logo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, crop: defaultCrop }),
      });
    } catch (error: any) {
      console.error(error);
      toast({
        title: 'ロゴのアップロードに失敗しました',
        description: error?.message ?? '時間をおいて再度お試しください。',
        status: 'error',
        duration: 4000,
        isClosable: true,
        position: 'top-right',
      });
    }
  };

  return (
    <Stack spacing={6} align="stretch">
      <Stack spacing={1} align="flex-start">
        <Heading size="lg">外観設定</Heading>
        <Text fontSize="sm" color="fg.muted">
          管理画面と患者画面のブランド要素をまとめて調整できます。
        </Text>
      </Stack>

      <Stack spacing={6} align="stretch">
        <Section
          title="基本情報"
          description="患者向け画面や管理画面で表示する名称を設定します。"
        >
        <FormControl>
          <FormLabel>システム表示名</FormLabel>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: Monshinクリニック"
          />
          <Text fontSize="sm" color="fg.muted">
            未入力の場合は「Monshinクリニック」が自動で表示されます。
          </Text>
        </FormControl>
        </Section>

      <Section
        title="画面メッセージ"
        description="問診開始時と完了時に表示される案内文を編集できます。"
      >
        <FormControl>
          <FormLabel>完了画面のメッセージ</FormLabel>
          <Textarea
            value={completionMessage}
            onChange={(e) => setCompletionMessage(e.target.value)}
            placeholder="例: ご回答ありがとうございました。"
          />
          <Text fontSize="sm" color="fg.muted">
            回答完了後のサンクスメッセージとして利用されます。
          </Text>
        </FormControl>
        <FormControl>
          <FormLabel>問診開始画面のメッセージ</FormLabel>
          <Textarea
            value={entryMessage}
            onChange={(e) => setEntryMessage(e.target.value)}
            placeholder="例: 不明点があれば受付にお知らせください"
          />
          <Text fontSize="sm" color="fg.muted">
            受付での案内や注意事項などを記載してください。
          </Text>
        </FormControl>
        </Section>

        <Section
          title="ブランドカラー"
          description="アクセントカラーを選択すると患者・管理画面の主要ボタンに反映されます。"
        >
        <Wrap spacing={3}>
          {colorPresets.map((preset) => {
            const isSelected = selectedColor === preset.value && !isCustom;
            return (
              <WrapItem key={preset.value}>
                <VStack spacing={1} align="center">
                  <Tooltip label={`${preset.label} (${preset.value.toUpperCase()})`}>
                    <IconButton
                      aria-label={`${preset.label} (${preset.value.toUpperCase()})`}
                      size="sm"
                      icon={<CheckIcon opacity={isSelected ? 1 : 0} />}
                      onClick={() => selectPreset(preset.value)}
                      bg={preset.value}
                      color={getContrastingIconColor(preset.value)}
                      borderWidth={isSelected ? 2 : 1}
                      borderColor={isSelected ? 'accent.solid' : 'gray.300'}
                      _hover={{ opacity: 0.85, bg: preset.value }}
                      _active={{ opacity: 0.9, bg: preset.value }}
                      _focusVisible={{ boxShadow: '0 0 0 3px rgba(66, 153, 225, 0.6)' }}
                      rounded="full"
                    />
                  </Tooltip>
                  <Text fontSize="xs" color="fg.muted">
                    {preset.label}
                  </Text>
                </VStack>
              </WrapItem>
            );
          })}
          <WrapItem>
            <Popover isOpen={isOpen} onOpen={handlePopoverOpen} onClose={onClose} placement="bottom-start">
              <PopoverTrigger>
                <Box>
                  <Tooltip label="カスタムカラーを設定">
                    <IconButton
                      aria-label="カスタムカラーを設定"
                      size="sm"
                      icon={<AddIcon />}
                      bg={customColor}
                      color={customButtonIconColor}
                      borderWidth={isCustom ? 2 : 1}
                      borderColor={isCustom ? 'accent.solid' : 'gray.300'}
                      _hover={{ opacity: 0.85, bg: customColor }}
                      _active={{ opacity: 0.9, bg: customColor }}
                      _focusVisible={{ boxShadow: '0 0 0 3px rgba(66, 153, 225, 0.6)' }}
                      rounded="full"
                    />
                  </Tooltip>
                </Box>
              </PopoverTrigger>
              <PopoverContent w="auto">
                <PopoverArrow />
                <PopoverCloseButton />
                <PopoverBody>
                  <VStack spacing={2} align="stretch">
                    <Text fontSize="sm" color="fg.muted">
                      16進数またはカラーピッカーで設定してください。
                    </Text>
                    <HStack>
                      <Input
                        value={selectedColor}
                        onChange={onCustomChange}
                        placeholder="#RRGGBB"
                        maxW="150px"
                      />
                      <Input type="color" value={selectedColor} onChange={onCustomChange} maxW="60px" p={0} />
                    </HStack>
                  </VStack>
                </PopoverBody>
              </PopoverContent>
            </Popover>
          </WrapItem>
        </Wrap>
        <HStack spacing={3} pt={2} align="center">
          <Box
            w="28px"
            h="28px"
            borderRadius="full"
            borderWidth="1px"
            borderColor="gray.300"
            bg={selectedColor || '#1976D2'}
          />
          <Text fontSize="sm" color="fg.muted">
            {isCustom ? 'カスタムカラー' : 'プリセットカラー'} / {(selectedColor || '#1976D2').toUpperCase()}
          </Text>
        </HStack>
      </Section>

      <Section
        title="ロゴ / アイコン"
        description="問診画面のヘッダーや管理画面に表示されるロゴ画像を設定します。"
      >
        <FormControl>
          <FormLabel>クリニックのロゴ/アイコン</FormLabel>
          <VStack align="stretch" spacing={4}>
            <Text fontSize="sm" color="fg.muted">
              PNG / JPEG 推奨。画像をアップロード後、青い枠をドラッグして表示範囲を調整してください。
            </Text>
            <HStack align="flex-start" spacing={6} flexWrap="wrap">
              <VStack spacing={2} align="center">
                <Text fontSize="sm" color="fg.muted">
                  プレビュー
                </Text>
                {iconPreview}
              </VStack>
              <VStack align="stretch" spacing={3} flex={1} minW="260px">
                <Input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadLogo(f);
                    e.target.value = '';
                  }}
                />
                {logoUrl ? (
                  <VStack align="stretch" spacing={3}>
                    <Text fontSize="sm" color="fg.muted">
                      枠の角や辺をドラッグするとサイズを変更できます。内部をドラッグすると位置を移動できます。
                    </Text>
                    <Box position="relative" maxW="320px" userSelect="none">
                      <img ref={imageRef} src={logoUrl} alt="logo" style={{ width: '100%', height: 'auto', display: 'block' }} />
                      <Box
                        position="absolute"
                        inset={0}
                        onPointerDown={(e) => {
                          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                          const relX = (e.clientX - rect.left) / rect.width;
                          const relY = (e.clientY - rect.top) / rect.height;
                          const hx = crop.x, hy = crop.y, hw = crop.w, hh = crop.h;
                          const left = hx, top = hy, right = hx + hw, bottom = hy + hh;
                          const edge = 0.02;
                          let mode: DragMode = 'none';
                          const near = (v: number, target: number) => Math.abs(v - target) <= edge;
                          const insideX = relX >= left && relX <= right;
                          const insideY = relY >= top && relY <= bottom;
                          if (near(relY, top) && near(relX, left)) mode = 'nw';
                          else if (near(relY, top) && near(relX, right)) mode = 'ne';
                          else if (near(relY, bottom) && near(relX, left)) mode = 'sw';
                          else if (near(relY, bottom) && near(relX, right)) mode = 'se';
                          else if (insideX && near(relY, top)) mode = 'n';
                          else if (insideX && near(relY, bottom)) mode = 's';
                          else if (insideY && near(relX, left)) mode = 'w';
                          else if (insideY && near(relX, right)) mode = 'e';
                          else if (insideX && insideY) mode = 'move';
                          if (mode !== 'none') {
                            setDragMode(mode);
                            dragStartRef.current = { px: e.clientX, py: e.clientY, crop: { ...crop } };
                            (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                          }
                        }}
                        onPointerMove={(e) => {
                          if (dragMode === 'none' || !dragStartRef.current) return;
                          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                          const dx = (e.clientX - dragStartRef.current.px) / rect.width;
                          const dy = (e.clientY - dragStartRef.current.py) / rect.height;
                          const start = dragStartRef.current.crop;
                          let nx = start.x, ny = start.y, nw = start.w, nh = start.h;
                          const minSize = 0.05;
                          const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
                          const clampRect = (x: number, y: number, w: number, h: number) => {
                            x = clamp01(x); y = clamp01(y);
                            w = Math.max(minSize, Math.min(1 - x, w));
                            h = Math.max(minSize, Math.min(1 - y, h));
                            return { x, y, w, h };
                          };
                          switch (dragMode) {
                            case 'move':
                              ({ x: nx, y: ny, w: nw, h: nh } = clampRect(start.x + dx, start.y + dy, nw, nh));
                              break;
                            case 'nw':
                              nx = start.x + dx; ny = start.y + dy; nw = start.w - dx; nh = start.h - dy; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                            case 'ne':
                              ny = start.y + dy; nw = start.w + dx; nh = start.h - dy; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                            case 'sw':
                              nx = start.x + dx; nw = start.w - dx; nh = start.h + dy; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                            case 'se':
                              nw = start.w + dx; nh = start.h + dy; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                            case 'n':
                              ny = start.y + dy; nh = start.h - dy; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                            case 's':
                              nh = start.h + dy; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                            case 'w':
                              nx = start.x + dx; nw = start.w - dx; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                            case 'e':
                              nw = start.w + dx; ({ x: nx, y: ny, w: nw, h: nh } = clampRect(nx, ny, nw, nh));
                              break;
                          }
                          setCrop({ x: nx, y: ny, w: nw, h: nh });
                        }}
                        onPointerUp={(e) => {
                          (e.currentTarget as any).releasePointerCapture?.(e.pointerId);
                          setDragMode('none');
                          dragStartRef.current = null;
                        }}
                      >
                        <Box
                          position="absolute"
                          border="2px solid #3182CE"
                          boxShadow="0 0 0 100vmax rgba(0,0,0,0.2)"
                          style={{
                            left: `${crop.x * 100}%`,
                            top: `${crop.y * 100}%`,
                            width: `${crop.w * 100}%`,
                            height: `${crop.h * 100}%`,
                            boxSizing: 'border-box',
                            cursor: dragMode === 'move' ? 'move' : 'default',
                          }}
                        >
                          {['nw', 'ne', 'sw', 'se'].map((pos) => (
                            <Box
                              key={pos}
                              position="absolute"
                              w="12px"
                              h="12px"
                              bg="#3182CE"
                              borderRadius="2px"
                              style={{
                                left: pos.includes('w') ? '-6px' : pos.includes('e') ? 'calc(100% - 6px)' : 'calc(50% - 6px)',
                                top: pos.includes('n') ? '-6px' : pos.includes('s') ? 'calc(100% - 6px)' : 'calc(50% - 6px)',
                              }}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                setDragMode(pos as DragMode);
                                dragStartRef.current = { px: e.clientX, py: e.clientY, crop: { ...crop } };
                                (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                              }}
                            />
                          ))}
                          {['n', 's', 'w', 'e'].map((pos) => (
                            <Box
                              key={pos}
                              position="absolute"
                              bg="transparent"
                              style={{
                                cursor: pos === 'n' || pos === 's' ? 'ns-resize' : 'ew-resize',
                                left: pos === 'w' ? '-6px' : pos === 'e' ? 'calc(100% - 6px)' : '0',
                                top: pos === 'n' ? '-6px' : pos === 's' ? 'calc(100% - 6px)' : '0',
                                width: pos === 'n' || pos === 's' ? '100%' : '12px',
                                height: pos === 'w' || pos === 'e' ? '100%' : '12px',
                              }}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                setDragMode(pos as DragMode);
                                dragStartRef.current = { px: e.clientX, py: e.clientY, crop: { ...crop } };
                                (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                              }}
                            />
                          ))}
                        </Box>
                      </Box>
                    </Box>
                    <HStack spacing={3} align="stretch">
                      <Box flex={1}>
                        <FormLabel mb={1}>X</FormLabel>
                        <Input
                          type="number"
                          step="0.01"
                          min={0}
                          max={1}
                          value={crop.x}
                          onChange={(e) => setCrop((c) => ({ ...c, x: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) }))}
                        />
                      </Box>
                      <Box flex={1}>
                        <FormLabel mb={1}>Y</FormLabel>
                        <Input
                          type="number"
                          step="0.01"
                          min={0}
                          max={1}
                          value={crop.y}
                          onChange={(e) => setCrop((c) => ({ ...c, y: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) }))}
                        />
                      </Box>
                    </HStack>
                    <HStack spacing={3} align="stretch">
                      <Box flex={1}>
                        <FormLabel mb={1}>幅</FormLabel>
                        <Input
                          type="number"
                          step="0.01"
                          min={0.05}
                          max={1}
                          value={crop.w}
                          onChange={(e) => setCrop((c) => ({ ...c, w: Math.max(0.05, Math.min(1, parseFloat(e.target.value) || 1)) }))}
                        />
                      </Box>
                      <Box flex={1}>
                        <FormLabel mb={1}>高さ</FormLabel>
                        <Input
                          type="number"
                          step="0.01"
                          min={0.05}
                          max={1}
                          value={crop.h}
                          onChange={(e) => setCrop((c) => ({ ...c, h: Math.max(0.05, Math.min(1, parseFloat(e.target.value) || 1)) }))}
                        />
                      </Box>
                    </HStack>
                    <HStack spacing={2}>
                      <Button size="sm" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
                        全体
                      </Button>
                      <Button size="sm" onClick={() => setCrop((c) => ({ ...c, h: c.w }))}>
                        正方形
                      </Button>
                      <Button size="sm" onClick={() => setCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })}>
                        中央にリセット
                      </Button>
                    </HStack>
                  </VStack>
                ) : (
                  <Text fontSize="sm" color="fg.muted">
                    画像をアップロードするとトリミング設定が表示されます。
                  </Text>
                )}
              </VStack>
            </HStack>
          </VStack>
        </FormControl>
      </Section>

      <Section
        title="保存"
        description="変更内容を保存して、患者画面と管理画面に即時反映します。"
        footer={
          <HStack justify="flex-end" spacing={4} w="100%" flexWrap="wrap" alignItems="center">
            {status && (
              <Text fontSize="sm" color={status.type === 'success' ? 'green.500' : 'red.500'} mt={{ base: 2, sm: 0 }}>
                {status.message}
              </Text>
            )}
            <Button onClick={save} colorScheme="primary" isLoading={loading}>
              保存
            </Button>
          </HStack>
        }
      >
        <Text fontSize="sm" color="fg.muted">
          保存するとブランドカラーやロゴ、各種メッセージがすぐに反映されます。必要に応じて患者画面で表示を確認してください。
        </Text>
      </Section>
    </Stack>
  </Stack>
  );
}
