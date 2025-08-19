// 医療機関向け UI デザイントークン + Chakra テーマ
// 方針: 高コントラスト/可読性・一貫した間隔・半径8px・最小限のモーション
import { extendTheme, ThemeConfig } from '@chakra-ui/react';

const config: ThemeConfig = {
  initialColorMode: 'light',
  useSystemColorMode: false,
};

// カラーパレット（ややデサチュレートのブルーを主系）
const colors = {
  primary: {
    50: '#e3f2fd',
    100: '#bbdefb',
    200: '#90caf9',
    300: '#64b5f6',
    400: '#42a5f5',
    500: '#1e88e5', // 基調色（安心感のあるブルー）
    600: '#1565c0',
    700: '#0d47a1',
    800: '#0b3b85',
    900: '#082a5e',
  },
  success: {
    50: '#e8f5e9',
    100: '#c8e6c9',
    200: '#a5d6a7',
    300: '#81c784',
    400: '#66bb6a',
    500: '#2e7d32',
    600: '#1b5e20',
    700: '#124a18',
    800: '#0c3611',
    900: '#07240b',
  },
  warning: {
    50: '#fff3e0',
    100: '#ffe0b2',
    200: '#ffcc80',
    300: '#ffb74d',
    400: '#ffa726',
    500: '#ed6c02',
    600: '#e65100',
    700: '#b33f00',
    800: '#803000',
    900: '#4d1d00',
  },
  danger: {
    50: '#ffebee',
    100: '#ffcdd2',
    200: '#ef9a9a',
    300: '#e57373',
    400: '#ef5350',
    500: '#d32f2f',
    600: '#b71c1c',
    700: '#911515',
    800: '#6c0f0f',
    900: '#470a0a',
  },
  neutral: {
    50: '#fafafa',
    100: '#f5f5f5',
    200: '#eeeeee',
    300: '#e0e0e0',
    400: '#bdbdbd',
    500: '#9e9e9e',
    600: '#757575',
    700: '#616161',
    800: '#424242',
    900: '#212121',
  },
};

// セマンティックトークン（ライト基調）
const semanticTokens = {
  colors: {
    'bg.canvas': { default: 'neutral.50' },
    'bg.surface': { default: 'white' },
    'fg.default': { default: 'neutral.900' },
    // AA準拠の視認性を確保するため muted は 700 を採用
    'fg.muted': { default: 'neutral.700' },
    'border.default': { default: 'neutral.300' },
    // リンクは primary.700 を既定にしてコントラスト確保
    'link.default': { default: 'primary.700' },
  },
  radii: {
    card: '8px',
  },
};

const fonts = {
  heading: "'Noto Sans JP', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Apple Color Emoji', 'Segoe UI Emoji'",
  body: "'Noto Sans JP', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Apple Color Emoji', 'Segoe UI Emoji'",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

const styles = {
  global: {
    'html, body, #root': {
      height: '100%',
    },
    body: {
      bg: 'bg.canvas',
      color: 'fg.default',
      fontSize: '16px',
      lineHeight: 1.6,
      letterSpacing: '0.02em',
      WebkitFontSmoothing: 'antialiased',
      MozOsxFontSmoothing: 'grayscale',
    },
    'a': {
      color: 'link.default',
    },
    // 印刷最適化
    '@media print': {
      body: {
        bg: 'white !important',
        color: 'black',
        fontSize: '12pt',
      },
    },
    // 印刷ユーティリティ
    '.print-hidden': {
      '@media print': {
        display: 'none !important',
      },
    },
    '.print-only': {
      display: 'none',
      '@media print': {
        display: 'block !important',
      },
    },
    '.print-break': {
      '@media print': {
        breakBefore: 'page',
        pageBreakBefore: 'always',
      },
    },
  },
};

const components = {
  Button: {
    defaultProps: {
      colorScheme: 'primary',
      size: 'md',
      variant: 'solid',
    },
    baseStyle: {
      borderRadius: '8px',
      fontWeight: 600,
    },
    variants: {
      solid: {
        bg: 'primary.600',
        color: 'white',
        _hover: { bg: 'primary.700' },
        _active: { bg: 'primary.800' },
      },
      outline: {
        borderColor: 'primary.600',
        color: 'primary.700',
        _hover: { bg: 'primary.50' },
      },
    },
    sizes: {
      sm: { h: '32px', px: '12px' },
      md: { h: '40px', px: '16px' },
      lg: { h: '48px', px: '20px' },
    },
  },
  Input: {
    baseStyle: { field: { borderRadius: '8px' } },
    sizes: { md: { field: { h: '40px' } } },
  },
  Select: {
    baseStyle: { field: { borderRadius: '8px' } },
  },
  Textarea: {
    baseStyle: { borderRadius: '8px' },
  },
  Modal: {
    baseStyle: {
      dialog: { borderRadius: '12px' },
    },
  },
  Radio: {
    defaultProps: { size: 'lg' },
  },
  Checkbox: {
    defaultProps: { size: 'lg' },
  },
};

const theme = extendTheme({
  config,
  colors,
  semanticTokens,
  fonts,
  styles,
  components,
});

export default theme;
