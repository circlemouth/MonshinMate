import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from '@chakra-ui/react';
import { AddIcon, CheckIcon } from '@chakra-ui/icons';
import AutoSaveStatusText from '../components/AutoSaveStatusText';
import { useThemeColor } from '../contexts/ThemeColorContext';
import { useAutoSave } from '../hooks/useAutoSave';
import { readErrorMessage } from '../utils/http';
import { useNotify } from '../contexts/NotificationContext';

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
const defaultCropState = { x: 0, y: 0, w: 1, h: 1 } as const;

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
  const { notify } = useNotify();
  const showErrorToast = useCallback(
    (title: string, description?: string) => {
      notify({
        title,
        description,
        status: 'error',
        channel: 'admin',
        duration: 4000,
      });
    },
    [notify]
  );

  type LogoConfig = { url: string | null; crop: { x: number; y: number; w: number; h: number } };

  // Logo states
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number }>(() => ({ ...defaultCropState }));
  type DragMode = 'none' | 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';
  const [dragMode, setDragMode] = useState<DragMode>('none');
  const dragStartRef = useRef<{ px: number; py: number; crop: { x: number; y: number; w: number; h: number } } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [logoLoaded, setLogoLoaded] = useState(false);

  const saveDisplayName = useCallback(
    async (current: string, signal: AbortSignal) => {
      const payload = { display_name: current || 'Monshinクリニック' };
      const res = await fetch('/system/display-name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, '表示名の保存に失敗しました'));
      }
      const data = await res.json().catch(() => ({}));
      const savedName = data.display_name || payload.display_name;
      setName(savedName);
      try {
        window.dispatchEvent(new CustomEvent('systemDisplayNameUpdated', { detail: savedName }));
      } catch {
        // ignore event dispatch errors
      }
      return savedName;
    },
    []
  );

  const saveCompletion = useCallback(
    async (current: string, signal: AbortSignal) => {
      const payload = { message: current || 'ご回答ありがとうございました。' };
      const res = await fetch('/system/completion-message', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, '完了メッセージの保存に失敗しました'));
      }
      const data = await res.json().catch(() => ({}));
      const savedMessage = data.message || payload.message;
      setCompletionMessage(savedMessage);
      return savedMessage;
    },
    []
  );

  const saveEntry = useCallback(
    async (current: string, signal: AbortSignal) => {
      const payload = { message: current || '不明点があれば受付にお知らせください' };
      const res = await fetch('/system/entry-message', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, '問診開始画面メッセージの保存に失敗しました'));
      }
      const data = await res.json().catch(() => ({}));
      const savedMessage = data.message || payload.message;
      setEntryMessage(savedMessage);
      return savedMessage;
    },
    []
  );

  const saveThemeColor = useCallback(
    async (currentColor: string, signal: AbortSignal) => {
      const payload = { color: currentColor || '#1976D2' };
      const res = await fetch('/system/theme-color', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, 'テーマカラーの保存に失敗しました'));
      }
      const data = await res.json().catch(() => ({}));
      const savedColor = data.color || payload.color;
      setSelectedColor(savedColor);
      const preset = presetValues.includes(savedColor);
      setIsCustom(!preset);
      if (!preset) {
        setCustomColor(savedColor);
      }
      setColor(savedColor);
      return savedColor;
    },
    [setColor]
  );

  const logoConfig = useMemo<LogoConfig>(() => ({ url: logoUrl, crop }), [logoUrl, crop]);

  const saveLogoConfig = useCallback(
    async (config: LogoConfig, signal: AbortSignal) => {
      if (!config.url) {
        return config;
      }
      const res = await fetch('/system/logo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: config.url, crop: config.crop }),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, 'ロゴの保存に失敗しました'));
      }
      try {
        window.dispatchEvent(new CustomEvent('systemLogoUpdated', { detail: config }));
      } catch {
        // ignore errors when dispatching events
      }
      return config;
    },
    []
  );

  const handleNameError = useCallback(
    (_: unknown, message: string) => {
      showErrorToast('表示名の保存に失敗しました', message !== '表示名の保存に失敗しました' ? message : undefined);
    },
    [showErrorToast]
  );
  const handleCompletionError = useCallback(
    (_: unknown, message: string) => {
      showErrorToast('完了メッセージの保存に失敗しました', message !== '完了メッセージの保存に失敗しました' ? message : undefined);
    },
    [showErrorToast]
  );
  const handleEntryError = useCallback(
    (_: unknown, message: string) => {
      showErrorToast('問診開始画面メッセージの保存に失敗しました', message !== '問診開始画面メッセージの保存に失敗しました' ? message : undefined);
    },
    [showErrorToast]
  );
  const handleColorError = useCallback(
    (_: unknown, message: string) => {
      showErrorToast('テーマカラーの保存に失敗しました', message !== 'テーマカラーの保存に失敗しました' ? message : undefined);
    },
    [showErrorToast]
  );
  const handleLogoError = useCallback(
    (_: unknown, message: string) => {
      showErrorToast('ロゴの保存に失敗しました', message !== 'ロゴの保存に失敗しました' ? message : undefined);
    },
    [showErrorToast]
  );

  const {
    status: nameStatus,
    errorMessage: nameError,
    markSynced: markNameSynced,
  } = useAutoSave<string>({
    value: name,
    save: saveDisplayName,
    delay: 600,
    onError: handleNameError,
  });
  const {
    status: completionStatus,
    errorMessage: completionError,
    markSynced: markCompletionSynced,
  } = useAutoSave<string>({
    value: completionMessage,
    save: saveCompletion,
    delay: 600,
    onError: handleCompletionError,
  });
  const {
    status: entryStatus,
    errorMessage: entryError,
    markSynced: markEntrySynced,
  } = useAutoSave<string>({
    value: entryMessage,
    save: saveEntry,
    delay: 600,
    onError: handleEntryError,
  });
  const {
    status: colorStatus,
    errorMessage: colorError,
    markSynced: markColorSynced,
  } = useAutoSave<string>({
    value: selectedColor,
    save: saveThemeColor,
    delay: 400,
    onError: handleColorError,
  });
  const {
    status: logoStatus,
    errorMessage: logoError,
    markSynced: markLogoSynced,
  } = useAutoSave<LogoConfig>({
    value: logoConfig,
    enabled: logoLoaded && !!logoUrl,
    delay: 800,
    compare: (next, prev) => {
      if (!prev) return false;
      return (
        next.url === prev.url &&
        next.crop.x === prev.crop.x &&
        next.crop.y === prev.crop.y &&
        next.crop.w === prev.crop.w &&
        next.crop.h === prev.crop.h
      );
    },
    save: saveLogoConfig,
    onError: handleLogoError,
  });

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      try {
        const res = await fetch('/system/display-name');
        if (canceled) return;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const initial = data.display_name || 'Monshinクリニック';
          setName(initial);
          markNameSynced(initial);
        } else {
          throw new Error();
        }
      } catch {
        if (!canceled) {
          const fallback = 'Monshinクリニック';
          setName(fallback);
          markNameSynced(fallback);
        }
      }

      try {
        const res = await fetch('/system/completion-message');
        if (canceled) return;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const initial = data.message || 'ご回答ありがとうございました。';
          setCompletionMessage(initial);
          markCompletionSynced(initial);
        } else {
          throw new Error();
        }
      } catch {
        if (!canceled) {
          const fallback = 'ご回答ありがとうございました。';
          setCompletionMessage(fallback);
          markCompletionSynced(fallback);
        }
      }

      try {
        const res = await fetch('/system/entry-message');
        if (canceled) return;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const initial = data.message || '不明点があれば受付にお知らせください';
          setEntryMessage(initial);
          markEntrySynced(initial);
        } else {
          throw new Error();
        }
      } catch {
        if (!canceled) {
          const fallback = '不明点があれば受付にお知らせください';
          setEntryMessage(fallback);
          markEntrySynced(fallback);
        }
      }
    };

    load();
    return () => {
      canceled = true;
    };
  }, [markNameSynced, markCompletionSynced, markEntrySynced]);

  useEffect(() => {
    const nextColor = color || '#1976D2';
    setSelectedColor(nextColor);
    const preset = presetValues.includes(nextColor);
    setIsCustom(!preset);
    if (!preset) {
      setCustomColor(nextColor);
    }
    markColorSynced(nextColor);
  }, [color, markColorSynced]);

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const res = await fetch('/system/logo');
        if (canceled) return;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const nextUrl = typeof data?.url === 'string' ? data.url : null;
          const nextCrop = {
            x: data?.crop?.x ?? defaultCropState.x,
            y: data?.crop?.y ?? defaultCropState.y,
            w: data?.crop?.w ?? defaultCropState.w,
            h: data?.crop?.h ?? defaultCropState.h,
          };
          setLogoUrl(nextUrl);
          setCrop(nextCrop);
          markLogoSynced({ url: nextUrl, crop: nextCrop });
        } else {
          throw new Error();
        }
      } catch {
        if (!canceled) {
          const fallbackCrop = { ...defaultCropState };
          setLogoUrl(null);
          setCrop(fallbackCrop);
          markLogoSynced({ url: null, crop: fallbackCrop });
        }
      } finally {
        if (!canceled) {
          setLogoLoaded(true);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [markLogoSynced]);

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
    const defaultCrop = { ...defaultCropState };
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
      const res = await fetch('/system/logo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, crop: defaultCrop }),
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, 'ロゴの保存に失敗しました'));
      }
      markLogoSynced({ url, crop: defaultCrop });
      try {
        window.dispatchEvent(new CustomEvent('systemLogoUpdated', { detail: { url, crop: defaultCrop } }));
      } catch {
        // ignore dispatch errors
      }
    } catch (error: any) {
      console.error(error);
      showErrorToast('ロゴのアップロードに失敗しました', error?.message ?? '時間をおいて再度お試しください。');
    }
  };

  return (
    <Stack spacing={6} align="stretch">
      <Stack spacing={1} align="flex-start">
        <Heading size="lg">外観設定</Heading>
        <Text fontSize="sm" color="fg.muted">
          管理画面と患者画面のブランド要素をまとめて調整できます。各項目は変更後すぐに自動保存され、全画面へ即時反映されます。
        </Text>
      </Stack>

      <Stack spacing={6} align="stretch">
        <Section
          title="基本情報"
          description="患者向け画面や管理画面で表示する名称を設定します。入力すると数秒以内に自動保存されます。"
        >
          <FormControl>
            <FormLabel>システム表示名</FormLabel>
            <Stack spacing={1} align="stretch">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: Monshinクリニック"
              />
              <AutoSaveStatusText status={nameStatus} message={nameError} />
            </Stack>
            <Text fontSize="sm" color="fg.muted">
              未入力の場合は「Monshinクリニック」が自動で表示されます。
            </Text>
          </FormControl>
        </Section>

      <Section
        title="画面メッセージ"
        description="問診開始時と完了時に表示される案内文を編集できます。入力内容は自動的に保存されます。"
      >
        <FormControl>
          <FormLabel>完了画面のメッセージ</FormLabel>
          <Stack spacing={1} align="stretch">
            <Textarea
              value={completionMessage}
              onChange={(e) => setCompletionMessage(e.target.value)}
              placeholder="例: ご回答ありがとうございました。"
            />
            <AutoSaveStatusText status={completionStatus} message={completionError} />
          </Stack>
          <Text fontSize="sm" color="fg.muted">
            回答完了後のサンクスメッセージとして利用されます。
          </Text>
        </FormControl>
        <FormControl>
          <FormLabel>問診開始画面のメッセージ</FormLabel>
          <Stack spacing={1} align="stretch">
            <Textarea
              value={entryMessage}
              onChange={(e) => setEntryMessage(e.target.value)}
              placeholder="例: 不明点があれば受付にお知らせください"
            />
            <AutoSaveStatusText status={entryStatus} message={entryError} />
          </Stack>
          <Text fontSize="sm" color="fg.muted">
            受付での案内や注意事項などを記載してください。
          </Text>
        </FormControl>
      </Section>

        <Section
          title="ブランドカラー"
          description="アクセントカラーを選択すると患者・管理画面の主要ボタンに反映されます。選択や入力は自動保存されます。"
        >
          <Stack spacing={3} align="stretch">
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
            <AutoSaveStatusText status={colorStatus} message={colorError} />
            <HStack spacing={3} align="center">
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
          </Stack>
        </Section>

      <Section
        title="ロゴ / アイコン"
        description="問診画面のヘッダーや管理画面に表示されるロゴ画像を設定します。トリミングや数値入力も自動で保存されます。"
      >
        <FormControl>
          <FormLabel>クリニックのロゴ/アイコン</FormLabel>
          <VStack align="stretch" spacing={4}>
            <Text fontSize="sm" color="fg.muted">
              PNG / JPEG 推奨。画像をアップロード後、青い枠をドラッグして表示範囲を調整してください。
            </Text>
            <AutoSaveStatusText status={logoStatus} message={logoError} />
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

    </Stack>
  </Stack>
  );
}
