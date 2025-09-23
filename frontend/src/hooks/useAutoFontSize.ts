import { useCallback, useLayoutEffect, type RefObject } from 'react';

interface AutoFontSizeOptions {
  /** フォントサイズの最小値（px）。未指定時は現在値の約60%を下限とする。 */
  minSize?: number;
  /** フォントサイズの最大値（px）。未指定時は要素の現在のフォントサイズを利用する。 */
  maxSize?: number;
  /** フォントサイズを段階的に縮小する際の刻み幅（px）。 */
  step?: number;
}

/**
 * テキストが折り返されないよう、要素のフォントサイズを自動で調整するフック。
 * `dependency` には表示内容など、再計算が必要な値を渡す。
 */
export const useAutoFontSize = (
  ref: RefObject<HTMLElement>,
  dependency: unknown,
  options: AutoFontSizeOptions = {},
) => {
  const { minSize, maxSize, step = 0.5 } = options;

  const adjust = useCallback(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') {
      return;
    }

    const computedStyle = window.getComputedStyle(el);
    const baseFontSize = parseFloat(computedStyle.fontSize || '16');
    if (!Number.isFinite(baseFontSize) || baseFontSize <= 0) {
      return;
    }

    const resolvedMax = typeof maxSize === 'number' && maxSize > 0 ? maxSize : baseFontSize;
    const resolvedMinCandidate =
      typeof minSize === 'number' && minSize > 0 ? minSize : Math.max(12, Math.floor(resolvedMax * 0.6));
    const resolvedMin = Math.min(resolvedMax, resolvedMinCandidate);
    const decrement = step > 0 ? step : 0.5;

    const applyFontSize = (value: number) => {
      el.style.fontSize = `${value}px`;
    };

    applyFontSize(resolvedMax);

    if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth) {
      return;
    }

    let current = resolvedMax;
    let iterations = 0;
    const maxIterations = 120;

    while (current > resolvedMin && iterations < maxIterations) {
      const next = Math.max(resolvedMin, current - decrement);
      applyFontSize(next);
      current = next;
      iterations += 1;

      if (el.scrollWidth <= el.clientWidth) {
        break;
      }
    }
  }, [ref, minSize, maxSize, step, dependency]);

  useLayoutEffect(() => {
    adjust();
  }, [adjust]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', adjust);
      return () => window.removeEventListener('resize', adjust);
    }

    const el = ref.current;
    if (!el) {
      return;
    }

    const observer = new ResizeObserver(() => {
      adjust();
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, [adjust, ref]);
};

