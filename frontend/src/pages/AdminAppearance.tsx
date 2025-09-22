import { useEffect, useMemo, useRef, useState } from 'react';
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
    const isPreset = samples.includes(color);
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

      // Save logo settings (if any)
      await fetch('/system/logo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: logoUrl, crop }),
      });
      try { window.dispatchEvent(new CustomEvent('systemLogoUpdated', { detail: { url: logoUrl, crop } })); } catch {}

      setStatus('保存しました');
      onClose();
    } catch (e: any) {
      setStatus(e.message || '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const customButtonIconColor = getContrastingIconColor(customColor);

  const iconPreview = useMemo(() => {
    if (!logoUrl) return null;
    const x = crop.x ?? 0, y = crop.y ?? 0, w = crop.w || 1;
    const transform = `translate(${-x * 100}%, ${-y * 100}%) scale(${1 / (w || 1)})`;
    return (
      <Box w="40px" h="40px" borderRadius="full" overflow="hidden" bg="gray.100" position="relative">
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
    const r = await fetch('/system-logo', { method: 'POST', body: fd });
    if (!r.ok) return;
    const d = await r.json();
    const url = d.url as string;
    setLogoUrl(url);
    await fetch('/system/logo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  };

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
          <FormLabel>クリニックのロゴ/アイコン</FormLabel>
          <HStack align="flex-start" spacing={4}>
            {iconPreview}
            <VStack align="stretch" spacing={2} flex={1}>
              <Input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); }} />
              {logoUrl && (
                <>
                  <Box position="relative" maxW="320px" userSelect="none">
                    <img ref={imageRef} src={logoUrl} alt="logo" style={{ width: '100%', height: 'auto', display: 'block' }} />
                    {/* Draggable/resizeable overlay */}
                    <Box position="absolute" inset={0}
                      onPointerDown={(e) => {
                        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                        const relX = (e.clientX - rect.left) / rect.width;
                        const relY = (e.clientY - rect.top) / rect.height;
                        // detect handle or inside
                        const hx = crop.x, hy = crop.y, hw = crop.w, hh = crop.h;
                        const left = hx, top = hy, right = hx + hw, bottom = hy + hh;
                        const edge = 0.02; // 2% margin
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
                      <Box position="absolute" border="2px solid #3182CE" boxShadow="0 0 0 100vmax rgba(0,0,0,0.2)" style={{
                        left: `${crop.x * 100}%`,
                        top: `${crop.y * 100}%`,
                        width: `${crop.w * 100}%`,
                        height: `${crop.h * 100}%`,
                        boxSizing: 'border-box',
                        cursor: dragMode === 'move' ? 'move' : 'default',
                      }}>
                        {/* Handles */}
                        {['nw','ne','sw','se'].map((pos) => (
                          <Box key={pos} position="absolute" w="12px" h="12px" bg="#3182CE" borderRadius="2px"
                            style={{
                              left: pos.includes('w') ? '-6px' : pos.includes('e') ? 'calc(100% - 6px)' : 'calc(50% - 6px)',
                              top: pos.includes('n') ? '-6px' : pos.includes('s') ? 'calc(100% - 6px)' : 'calc(50% - 6px)'
                            }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              setDragMode(pos as DragMode);
                              dragStartRef.current = { px: e.clientX, py: e.clientY, crop: { ...crop } };
                              (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                            }}
                          />
                        ))}
                        {/* Edge handlers for easier resizing */}
                        {['n','s','w','e'].map((pos) => (
                          <Box key={pos} position="absolute" bg="transparent"
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
                  <HStack>
                    <Box flex={1}>
                      <FormLabel mb={1}>X</FormLabel>
                      <Input type="number" step="0.01" min={0} max={1} value={crop.x} onChange={(e) => setCrop((c) => ({ ...c, x: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) }))} />
                    </Box>
                    <Box flex={1}>
                      <FormLabel mb={1}>Y</FormLabel>
                      <Input type="number" step="0.01" min={0} max={1} value={crop.y} onChange={(e) => setCrop((c) => ({ ...c, y: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) }))} />
                    </Box>
                  </HStack>
                  <HStack>
                    <Box flex={1}>
                      <FormLabel mb={1}>幅</FormLabel>
                      <Input type="number" step="0.01" min={0.05} max={1} value={crop.w} onChange={(e) => setCrop((c) => ({ ...c, w: Math.max(0.05, Math.min(1, parseFloat(e.target.value) || 1)) }))} />
                    </Box>
                    <Box flex={1}>
                      <FormLabel mb={1}>高さ</FormLabel>
                      <Input type="number" step="0.01" min={0.05} max={1} value={crop.h} onChange={(e) => setCrop((c) => ({ ...c, h: Math.max(0.05, Math.min(1, parseFloat(e.target.value) || 1)) }))} />
                    </Box>
                  </HStack>
                  <HStack>
                    <Button size="sm" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>全体</Button>
                    <Button size="sm" onClick={() => setCrop((c) => ({ ...c, h: c.w }))}>正方形</Button>
                    <Button size="sm" onClick={() => setCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })}>中央にリセット</Button>
                  </HStack>
                </>
              )}
            </VStack>
          </HStack>
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
