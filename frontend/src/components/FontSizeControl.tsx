import { useEffect, useRef, useState } from 'react';
import { Box, IconButton, Slider, SliderTrack, SliderFilledTrack, SliderThumb, Text, useOutsideClick, HStack } from '@chakra-ui/react';
import { FiType } from 'react-icons/fi';

/**
 * 画面右下のフォントサイズ調整トグル。
 * - 常時右下に小さなアイコンを表示
 * - クリックでスライダーを展開し、連続的にフォントサイズを変更
 * - 画面の他の部位をクリックすると閉じる
 * - 設定は localStorage に保存し、次回以降も適用
 */
export default function FontSizeControl() {
  const STORAGE_KEY = 'rootFontSizePx';
  const DEFAULT_PX = 16; // ブラウザの標準 16px
  const MIN_PX = 14;
  const MAX_PX = 22;
  const STEP = 0.5;

  const [isOpen, setIsOpen] = useState(false);
  const [fontPx, setFontPx] = useState<number>(DEFAULT_PX);
  const ref = useRef<HTMLDivElement>(null);

  // 初期化: 保存値があれば適用
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const px = saved ? Number(saved) : DEFAULT_PX;
      const clamped = Number.isFinite(px) ? Math.min(MAX_PX, Math.max(MIN_PX, px)) : DEFAULT_PX;
      setFontPx(clamped);
      document.documentElement.style.fontSize = `${clamped}px`;
    } catch {
      // 失敗時はデフォルト
      document.documentElement.style.fontSize = `${DEFAULT_PX}px`;
    }
  }, []);

  // スライダー変更時: 即時に root のフォントサイズへ反映し、保存
  const handleChange = (v: number) => {
    setFontPx(v);
    document.documentElement.style.fontSize = `${v}px`;
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {}
  };

  // 外側クリックで閉じる
  useOutsideClick({
    ref,
    handler: () => setIsOpen(false),
  });

  return (
    <Box position="fixed" right={4} bottom={4} zIndex={1400} ref={ref}>
      {!isOpen && (
        <IconButton
          aria-label="フォントサイズを調整"
          icon={<FiType />}
          onClick={() => setIsOpen(true)}
          colorScheme="primary"
          borderRadius="full"
          size="md"
          shadow="md"
        />
      )}

      {isOpen && (
        <Box
          bg="white"
          borderWidth="1px"
          borderRadius="md"
          shadow="lg"
          p={3}
          minW="240px"
        >
          <HStack spacing={3} mb={2} align="center">
            <Box as={FiType} aria-hidden />
            <Text fontSize="sm" color="gray.700">文字サイズ</Text>
            <Text fontSize="xs" color="gray.500" ml="auto">{fontPx.toFixed(1)}px</Text>
          </HStack>
          <Slider
            aria-label="font-size-slider"
            min={MIN_PX}
            max={MAX_PX}
            step={STEP}
            value={fontPx}
            onChange={handleChange}
          >
            <SliderTrack>
              <SliderFilledTrack />
            </SliderTrack>
            <SliderThumb />
          </Slider>
        </Box>
      )}
    </Box>
  );
}

