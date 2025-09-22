import { Box, HStack, IconButton, Tooltip } from '@chakra-ui/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MdGpsFixed, MdGesture, MdUndo, MdDelete, MdZoomIn, MdZoomOut, MdCenterFocusWeak } from 'react-icons/md';
import { TbEraser } from 'react-icons/tb';

export type Point = { x: number; y: number };
export type Path = Point[];
export type ImageAnnotationValue = {
  points: Point[];
  paths: Path[];
};

type Mode = 'point' | 'lasso' | 'erase';

type Props = {
  src: string;
  value: ImageAnnotationValue | undefined;
  onChange: (val: ImageAnnotationValue) => void;
  height?: number; // px constraint; default 400
};

// Utility: clamp
const clamp = (v: number, min = 0, max = 1) => (v < min ? min : v > max ? max : v);

// Distance from point to segment
function distToSegment(p: Point, a: Point, b: Point): number {
  const x = p.x, y = p.y;
  const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
  const A = x - x1;
  const B = y - y1;
  const C = x2 - x1;
  const D = y2 - y1;
  const dot = A * C + B * D;
  const len_sq = C * C + D * D;
  let param = -1;
  if (len_sq !== 0) param = dot / len_sq;
  let xx, yy;
  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }
  const dx = x - xx;
  const dy = y - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

export default function ImageAnnotator({ src, value, onChange, height = 400 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [mode, setMode] = useState<Mode>('point');
  const [drawing, setDrawing] = useState<Path | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  const val: ImageAnnotationValue = value || { points: [], paths: [] };

  // Normalized -> screen coords helper
  const getRenderSize = (): { w: number; h: number } => {
    const img = imgRef.current;
    if (!img) return { w: 0, h: 0 };
    return { w: img.clientWidth, h: img.clientHeight };
  };

  const toScreen = (p: Point): { x: number; y: number } => {
    const { w, h } = getRenderSize();
    const cx = w / 2;
    const cy = h / 2;
    const x = (p.x - 0.5) * w * zoom + pan.x + cx;
    const y = (p.y - 0.5) * h * zoom + pan.y + cy;
    return { x, y };
  };

  const toNorm = (sx: number, sy: number): Point => {
    const { w, h } = getRenderSize();
    const cx = w / 2;
    const cy = h / 2;
    const x = ((sx - cx - pan.x) / (w * zoom)) + 0.5;
    const y = ((sy - cy - pan.y) / (h * zoom)) + 0.5;
    return { x: clamp(x), y: clamp(y) };
  };

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  };

  // Pointer interactions
  const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const target = e.currentTarget as HTMLDivElement;
    (target as any).setPointerCapture?.(e.pointerId);
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (mode === 'point') {
      const p = toNorm(x, y);
      onChange({ ...val, points: [...val.points, p] });
    } else if (mode === 'lasso') {
      const p = toNorm(x, y);
      setDrawing([p]);
    } else if (mode === 'erase') {
      const p = toNorm(x, y);
      eraseAt(p);
    } else {
      // no-op
    }
  };

  const onPointerMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const target = e.currentTarget as HTMLDivElement;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (mode === 'lasso' && drawing) {
      const p = toNorm(x, y);
      // Avoid duplicates for tiny moves
      const last = drawing[drawing.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.002) {
        setDrawing((d) => (d ? [...d, p] : [p]));
      }
    } else if (panning) {
      setPan((prev) => ({
        x: prev.x + (e.movementX || 0),
        y: prev.y + (e.movementY || 0),
      }));
    }
  };

  const onPointerUp: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const target = e.currentTarget as HTMLDivElement;
    (target as any).releasePointerCapture?.(e.pointerId);
    if (mode === 'lasso' && drawing && drawing.length > 1) {
      onChange({ ...val, paths: [...val.paths, drawing] });
    }
    setDrawing(null);
    setPanning(false);
    // end of interactions
  };

  // Erase helper
  const eraseAt = (p: Point) => {
    const radius = 12; // px
    const sp = toScreen(p);
    const hitPointIdx = val.points.findIndex((pt) => {
      const s = toScreen(pt);
      return Math.hypot(s.x - sp.x, s.y - sp.y) <= radius;
    });
    if (hitPointIdx >= 0) {
      const nextPts = [...val.points];
      nextPts.splice(hitPointIdx, 1);
      onChange({ ...val, points: nextPts });
      return;
    }
    // Paths: check min distance to any segment
    const threshold = 12; // px
    const pathIdx = val.paths.findIndex((path) => {
      if (path.length < 2) return false;
      // test against each segment in screen space
      for (let i = 1; i < path.length; i++) {
        const sa = toScreen(path[i - 1]);
        const sb = toScreen(path[i]);
        const d = distToSegment(sp, sa, sb);
        if (d <= threshold) return true;
      }
      return false;
    });
    if (pathIdx >= 0) {
      const nextPaths = [...val.paths];
      nextPaths.splice(pathIdx, 1);
      onChange({ ...val, paths: nextPaths });
    }
  };

  // Toolbar actions
  const undo = () => {
    if (drawing) {
      setDrawing(null);
      return;
    }
    if (val.paths.length > 0) {
      const next = [...val.paths];
      next.pop();
      onChange({ ...val, paths: next });
    } else if (val.points.length > 0) {
      const nextP = [...val.points];
      nextP.pop();
      onChange({ ...val, points: nextP });
    }
  };
  const clearAll = () => onChange({ points: [], paths: [] });

  const zoomIn = () => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100));
  const zoomOut = () => setZoom((z) => Math.max(1, Math.round((z - 0.25) * 100) / 100));
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const startPan = () => setPanning(true);

  // Render SVG overlay paths and points
  const overlay = useMemo(() => {
    const { w, h } = getRenderSize();
    const transform = `translate(${w / 2 + pan.x}px, ${h / 2 + pan.y}px) scale(${zoom}) translate(${-w / 2}px, ${-h / 2}px)`;
    return (
      <svg
        width={w}
        height={h}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        <g transform={transform}>
          {/* Existing paths */}
          {val.paths.map((path, idx) => (
            <polyline
              key={idx}
              points={path.map((p) => `${p.x * w},${p.y * h}`).join(' ')}
              fill="none"
              stroke="rgba(0, 122, 255, 0.9)"
              strokeWidth={3}
            />
          ))}
          {/* Current drawing */}
          {drawing && drawing.length > 0 && (
            <polyline
              points={drawing.map((p) => `${p.x * w},${p.y * h}`).join(' ')}
              fill="none"
              stroke="rgba(0, 122, 255, 0.6)"
              strokeDasharray="6 4"
              strokeWidth={3}
            />
          )}
          {/* Points */}
          {val.points.map((p, idx) => (
            <circle
              key={idx}
              cx={p.x * w}
              cy={p.y * h}
              r={7}
              fill="#FF3B30"
              stroke="#fff"
              strokeWidth={2}
            />
          ))}
        </g>
      </svg>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val.points, val.paths, drawing, zoom, pan, imgRef.current?.clientWidth, imgRef.current?.clientHeight]);

  return (
    <Box>
      <HStack spacing={2} mb={2}>
        <Tooltip label="Add point">
          <IconButton
            aria-label="point mode"
            icon={<MdGpsFixed />}
            onClick={() => setMode('point')}
            colorScheme={mode === 'point' ? 'primary' : undefined}
            size="sm"
          />
        </Tooltip>
        <Tooltip label="Lasso select">
          <IconButton
            aria-label="lasso mode"
            icon={<MdGesture />}
            onClick={() => setMode('lasso')}
            colorScheme={mode === 'lasso' ? 'primary' : undefined}
            size="sm"
          />
        </Tooltip>
        <Tooltip label="Erase">
          <IconButton
            aria-label="erase mode"
            icon={<TbEraser />}
            onClick={() => setMode('erase')}
            colorScheme={mode === 'erase' ? 'red' : undefined}
            size="sm"
          />
        </Tooltip>
        <Tooltip label="Undo">
          <IconButton aria-label="undo" icon={<MdUndo />} onClick={undo} size="sm" />
        </Tooltip>
        <Tooltip label="Clear all">
          <IconButton aria-label="clear" icon={<MdDelete />} onClick={clearAll} size="sm" />
        </Tooltip>
        <Tooltip label="Zoom in">
          <IconButton aria-label="zoom in" icon={<MdZoomIn />} onClick={zoomIn} size="sm" />
        </Tooltip>
        <Tooltip label="Zoom out">
          <IconButton aria-label="zoom out" icon={<MdZoomOut />} onClick={zoomOut} size="sm" />
        </Tooltip>
        <Tooltip label="Reset view">
          <IconButton aria-label="reset view" icon={<MdCenterFocusWeak />} onClick={resetView} size="sm" />
        </Tooltip>
      </HStack>
      <Box
        ref={containerRef}
        position="relative"
        w="100%"
        maxH={`${height}px`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={startPan}
        style={{ touchAction: 'none', userSelect: 'none' }}
      >
        <img
          ref={imgRef}
          src={src}
          alt=""
          onLoad={handleImgLoad}
          style={{ width: '100%', maxHeight: `${height}px`, objectFit: 'contain', display: 'block' }}
        />
        {overlay}
      </Box>
    </Box>
  );
}

