// 医療機関向け UI デザイントークン + Chakra テーマ
// 方針: 高コントラスト/可読性・一貫した間隔・半径8px・最小限のモーション
import { extendTheme, ThemeConfig, Theme } from '@chakra-ui/react';
import { StyleFunctionProps } from '@chakra-ui/theme-tools';
import tinycolor from 'tinycolor2';

const config: ThemeConfig = {
  initialColorMode: 'light',
  useSystemColorMode: false,
};

const success = {
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
};

const warning = {
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
};

const danger = {
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
};

const neutral = {
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
};

export type PrimaryRamp = {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
};

export interface AccentPalette {
  base: string;
  solid: string;
  subtle: string;
  muted: string;
  border: string;
  outline: string;
  emphasis: string;
  onFilled: string;
  alpha: Record<'8' | '12' | '16' | '24', string>;
}

function generatePrimary(base: string): PrimaryRamp {
  const c = tinycolor(base);
  const def = tinycolor('#1e88e5');
  const valid = c.isValid() ? c : def;
  return {
    50: valid.clone().lighten(40).toHexString(),
    100: valid.clone().lighten(32).toHexString(),
    200: valid.clone().lighten(24).toHexString(),
    300: valid.clone().lighten(16).toHexString(),
    400: valid.clone().lighten(8).toHexString(),
    500: valid.toHexString(),
    600: valid.clone().darken(8).toHexString(),
    700: valid.clone().darken(16).toHexString(),
    800: valid.clone().darken(24).toHexString(),
    900: valid.clone().darken(32).toHexString(),
  };
}

export function deriveAccentPalette(primary: PrimaryRamp): AccentPalette {
  const baseHex = primary[500];
  const solidHex = primary[600];
  const baseColor = tinycolor(baseHex);
  const solidColor = tinycolor(solidHex);

  const mixWithWhite = (amount: number) => tinycolor.mix('#ffffff', baseColor, amount).toHexString();

  const subtle = mixWithWhite(12);
  const muted = mixWithWhite(24);
  const border = mixWithWhite(45);

  const alpha8 = baseColor.clone().setAlpha(0.08).toRgbString();
  const alpha12 = baseColor.clone().setAlpha(0.12).toRgbString();
  const alpha16 = baseColor.clone().setAlpha(0.16).toRgbString();
  const alpha24 = baseColor.clone().setAlpha(0.24).toRgbString();

  const readableOnSolid = tinycolor
    .mostReadable(solidColor, ['#ffffff', '#1a202c'], {
      includeFallbackColors: true,
      level: 'AA',
      size: 'large',
    })
    .toHexString();

  return {
    base: baseColor.toHexString(),
    solid: solidColor.toHexString(),
    subtle,
    muted,
    border,
    outline: alpha24,
    emphasis: alpha16,
    onFilled: readableOnSolid,
    alpha: {
      '8': alpha8,
      '12': alpha12,
      '16': alpha16,
      '24': alpha24,
    },
  };
}

function buildSemanticTokens() {
  return {
    colors: {
      'bg.canvas': { default: 'neutral.50' },
      'bg.surface': { default: 'white' },
      'fg.default': { default: 'neutral.900' },
      // AA準拠の視認性を確保するため muted は 700 を採用
      'fg.muted': { default: 'neutral.700' },
      'border.default': { default: 'neutral.300' },
      // リンクは primary.700 を既定にしてコントラスト確保
      'link.default': { default: 'primary.700' },
      'bg.subtle': { default: 'accent.subtle' },
      'bg.emphasis': { default: 'accentAlpha.12' },
      'border.accent': { default: 'accent.border' },
      'fg.accent': { default: 'accent.solid' },
    },
    radii: {
      card: '8px',
    },
  } as const;
}

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

const ACCENT_FOCUS_RING =
  '0 0 0 1px var(--chakra-colors-accent-solid), 0 0 0 4px var(--chakra-colors-accentAlpha-24)';

const tagSubtleVariant = (props: StyleFunctionProps) => {
  const scheme = props.colorScheme ?? 'primary';
  if (scheme !== 'primary') {
    return {
      container: {
        bg: `${scheme}.100`,
        color: `${scheme}.800`,
      },
    };
  }
  return {
    container: {
      bg: 'accent.subtle',
      color: 'fg.accent',
      borderColor: 'border.accent',
      borderWidth: '1px',
    },
  };
};

const tagSolidVariant = (props: StyleFunctionProps) => {
  const scheme = props.colorScheme ?? 'primary';
  if (scheme !== 'primary') {
    return {
      container: {
        bg: `${scheme}.600`,
        color: 'white',
      },
    };
  }
  return {
    container: {
      bg: 'accent.solid',
      color: 'accent.onFilled',
    },
  };
};

const badgeSubtleVariant = (props: StyleFunctionProps) => {
  const scheme = props.colorScheme ?? 'primary';
  if (scheme !== 'primary') {
    return {
      bg: `${scheme}.100`,
      color: `${scheme}.800`,
    };
  }
  return {
    bg: 'accent.subtle',
    color: 'fg.accent',
    borderColor: 'border.accent',
    borderWidth: '1px',
  };
};

const badgeSolidVariant = (props: StyleFunctionProps) => {
  const scheme = props.colorScheme ?? 'primary';
  if (scheme !== 'primary') {
    return {
      bg: `${scheme}.600`,
      color: 'white',
    };
  }
  return {
    bg: 'accent.solid',
    color: 'accent.onFilled',
  };
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
      _focusVisible: {
        boxShadow: ACCENT_FOCUS_RING,
      },
    },
    variants: {
      solid: {
        bg: 'accent.solid',
        color: 'accent.onFilled',
        _hover: { bg: 'accent.base' },
        _active: { bg: 'primary.800' },
      },
      outline: {
        borderColor: 'border.accent',
        color: 'fg.accent',
        _hover: { bg: 'bg.subtle' },
        _active: { bg: 'bg.emphasis' },
      },
      ghost: {
        color: 'fg.accent',
        _hover: { bg: 'bg.subtle' },
        _active: { bg: 'bg.emphasis' },
      },
    },
    sizes: {
      sm: { h: '32px', px: '12px' },
      md: { h: '40px', px: '16px' },
      lg: { h: '48px', px: '20px' },
    },
  },
  Input: {
    defaultProps: { focusBorderColor: 'accent.solid' },
    baseStyle: {
      field: {
        borderRadius: '8px',
        _placeholder: { color: 'fg.muted' },
        _focusVisible: {
          boxShadow: ACCENT_FOCUS_RING,
        },
      },
    },
    sizes: { md: { field: { h: '40px' } } },
  },
  Select: {
    defaultProps: { focusBorderColor: 'accent.solid' },
    baseStyle: {
      field: {
        borderRadius: '8px',
        _focusVisible: {
          boxShadow: ACCENT_FOCUS_RING,
        },
      },
      icon: {
        color: 'fg.muted',
      },
    },
  },
  Textarea: {
    defaultProps: { focusBorderColor: 'accent.solid' },
    baseStyle: {
      borderRadius: '8px',
      _focusVisible: {
        boxShadow: ACCENT_FOCUS_RING,
      },
    },
  },
  Form: {
    baseStyle: {
      helperText: { color: 'fg.muted' },
      requiredIndicator: { color: 'accent.solid' },
    },
  },
  Modal: {
    baseStyle: {
      dialog: { borderRadius: '12px' },
    },
  },
  Tag: {
    baseStyle: {
      container: {
        borderRadius: 'full',
        fontWeight: 600,
      },
    },
    variants: {
      subtle: tagSubtleVariant,
      solid: tagSolidVariant,
    },
    defaultProps: {
      colorScheme: 'primary',
      variant: 'subtle',
      size: 'sm',
    },
  },
  Badge: {
    baseStyle: {
      borderRadius: 'full',
      fontWeight: 600,
      textTransform: 'none',
    },
    variants: {
      subtle: badgeSubtleVariant,
      solid: badgeSolidVariant,
    },
    defaultProps: {
      colorScheme: 'primary',
      variant: 'subtle',
    },
  },
  Tabs: {
    baseStyle: {
      tab: {
        fontWeight: 600,
        _focusVisible: { boxShadow: ACCENT_FOCUS_RING },
        _hover: { bg: 'bg.subtle' },
      },
      tablist: {
        borderColor: 'border.default',
      },
    },
    variants: {
      line: {
        tab: {
          _selected: {
            borderColor: 'accent.solid',
            color: 'fg.accent',
          },
        },
      },
      softRounded: {
        tab: {
          borderRadius: 'full',
          _selected: {
            bg: 'accent.subtle',
            color: 'fg.accent',
          },
        },
      },
    },
  },
  Slider: {
    baseStyle: {
      track: {
        bg: 'bg.subtle',
        borderRadius: 'full',
      },
      filledTrack: {
        bg: 'accent.solid',
      },
      thumb: {
        bg: 'white',
        borderWidth: '1px',
        borderColor: 'border.accent',
        boxShadow: 'base',
        _focusVisible: { boxShadow: ACCENT_FOCUS_RING },
      },
    },
  },
  Progress: {
    baseStyle: {
      track: {
        bg: 'bg.subtle',
        borderRadius: 'full',
      },
      filledTrack: {
        bg: 'accent.solid',
      },
    },
  },
  Menu: {
    baseStyle: {
      list: {
        border: '1px solid',
        borderColor: 'border.default',
        borderRadius: 'md',
        boxShadow: 'lg',
        py: 2,
      },
      item: {
        borderRadius: 'md',
        _hover: {
          bg: 'bg.subtle',
          color: 'fg.accent',
        },
        _focus: {
          bg: 'bg.emphasis',
        },
        _active: {
          bg: 'bg.emphasis',
        },
      },
      command: {
        opacity: 0.6,
      },
      divider: {
        borderColor: 'border.default',
      },
    },
  },
  Radio: {
    defaultProps: { size: 'lg', colorScheme: 'primary' },
    baseStyle: {
      control: {
        _focusVisible: { boxShadow: ACCENT_FOCUS_RING },
        _checked: {
          bg: 'accent.solid',
          borderColor: 'accent.solid',
        },
      },
    },
  },
  Checkbox: {
    defaultProps: { size: 'lg', colorScheme: 'primary' },
    baseStyle: {
      control: {
        borderRadius: '6px',
        _focusVisible: { boxShadow: ACCENT_FOCUS_RING },
        _checked: {
          bg: 'accent.solid',
          borderColor: 'accent.solid',
          color: 'accent.onFilled',
        },
      },
    },
  },
};

export interface ThemeArtifacts {
  theme: Theme;
  accentPalette: AccentPalette;
  primary: PrimaryRamp;
}

export function createThemeArtifacts(primaryColor: string): ThemeArtifacts {
  const primary = generatePrimary(primaryColor);
  const accentPalette = deriveAccentPalette(primary);
  const colors = {
    primary,
    accent: {
      base: accentPalette.base,
      solid: accentPalette.solid,
      subtle: accentPalette.subtle,
      muted: accentPalette.muted,
      border: accentPalette.border,
      outline: accentPalette.outline,
      emphasis: accentPalette.emphasis,
      onFilled: accentPalette.onFilled,
    },
    accentAlpha: accentPalette.alpha,
    success,
    warning,
    danger,
    neutral,
  };

  const theme = extendTheme({
    config,
    colors,
    semanticTokens: buildSemanticTokens(),
    fonts,
    styles,
    components,
  });

  return { theme, accentPalette, primary };
}

export function createTheme(primaryColor: string): Theme {
  return createThemeArtifacts(primaryColor).theme;
}

const { theme } = createThemeArtifacts('#1976D2');
export default theme;
