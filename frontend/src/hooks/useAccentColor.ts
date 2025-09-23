import { useToken } from '@chakra-ui/react';

/**
 * Returns resolved accent palette values from the current Chakra theme.
 */
export function useAccentColor() {
  const [base, solid, subtle, muted, border, onFilled, outline, emphasis] = useToken('colors', [
    'accent.base',
    'accent.solid',
    'accent.subtle',
    'accent.muted',
    'accent.border',
    'accent.onFilled',
    'accent.outline',
    'accent.emphasis',
  ]);

  const [alpha8, alpha12, alpha16, alpha24] = useToken('colors', [
    'accentAlpha.8',
    'accentAlpha.12',
    'accentAlpha.16',
    'accentAlpha.24',
  ]);

  return {
    base,
    solid,
    subtle,
    muted,
    border,
    onFilled,
    outline,
    emphasis,
    alpha: {
      8: alpha8,
      12: alpha12,
      16: alpha16,
      24: alpha24,
    },
  } as const;
}
