/**
 * A canvas that fills its tile at the screen's pixel ratio, and redraws only when its model or size changes.
 * A chart that can't shrink past a point says how large it draws for a given tile, and the canvas runs past
 * the tile by that much, where the host marks the cut.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Ctx } from './draw';

export interface Box {
  width: number;
  height: number;
  /**
   * Too small for axes and labels, as in the suggestion strip: the chart draws only its marks there,
   * so the same view reads as a thumbnail.
   */
  compact: boolean;
}

/** Below either of these, in CSS pixels, a chart is compact. */
export const COMPACT_BELOW = { width: 300, height: 150 };

/**
 * For the small tiles that are mostly rows of text: they still read full down to 90 pixels high, so
 * they're compact only when narrow, as in the suggestion strip, or very short.
 */
export const compactSmall = ({ width, height }: Pick<Box, 'width' | 'height'>): boolean => width < COMPACT_BELOW.width || height < 90;

export type Draw<M> = (ctx: Ctx, model: M, box: Box) => void;

/**
 * The size `model` draws at in a tile of `box`: the tile itself while it fits, and more once the chart
 * has stopped shrinking. Never less than the tile.
 */
export type Extent<M> = (model: M, box: Box) => { width: number; height: number };

interface Size {
  width: number;
  height: number;
  ratio: number;
}

/** Fonts load after the first paint: text drawn before then would stay in the fallback face. */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => typeof document === 'undefined' || document.fonts?.status === 'loaded');
  useEffect(() => {
    if (ready) return;
    let live = true;
    void document.fonts.ready.then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/**
 * Draws `model` with `draw`, a function that doesn't change. Keep the model's reference until its data changes.
 * `extent`, also a function that doesn't change, lets the canvas be larger than the tile.
 */
export function ChartCanvas<M>({ model, draw, extent }: { model: M; draw: Draw<M>; extent?: Extent<M> }) {
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState<{ width: number; height: number } | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const fonts = useFontsReady();

  useLayoutEffect(() => {
    const frame = box.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      const ratio = window.devicePixelRatio || 1;
      setSize((s) => (s && s.width === width && s.height === height && s.ratio === ratio ? s : { width, height, ratio }));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !size || size.width === 0 || size.height === 0) return;
    const compact = size.width < COMPACT_BELOW.width || size.height < COMPACT_BELOW.height;
    const tile = { width: size.width, height: size.height, compact };
    const wanted = extent?.(model, tile);
    const width = Math.max(size.width, Math.ceil(wanted?.width ?? 0));
    const height = Math.max(size.height, Math.ceil(wanted?.height ?? 0));
    canvas.width = Math.round(width * size.ratio);
    canvas.height = Math.round(height * size.ratio);
    ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    setDrawn((d) => (d && d.width === width && d.height === height ? d : { width, height }));
    draw(ctx, model, { width, height, compact });
  }, [model, draw, extent, size, fonts]);

  // The box is the tile, and the canvas is laid out at the size it draws: past the box when the chart asks.
  return (
    <div ref={box} className="chart-box">
      <canvas ref={ref} className="chart-canvas" style={drawn ? { width: drawn.width, height: drawn.height } : undefined} />
    </div>
  );
}
