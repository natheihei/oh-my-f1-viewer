/** A canvas that fills its tile at the screen's pixel ratio, and redraws only when its model or size changes. */
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

/** Draws `model` with `draw`, a function that doesn't change. Keep the model's reference until its data changes. */
export function ChartCanvas<M>({ model, draw }: { model: M; draw: Draw<M> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const fonts = useFontsReady();

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      const ratio = window.devicePixelRatio || 1;
      setSize((s) => (s && s.width === width && s.height === height && s.ratio === ratio ? s : { width, height, ratio }));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !size || size.width === 0 || size.height === 0) return;
    canvas.width = Math.round(size.width * size.ratio);
    canvas.height = Math.round(size.height * size.ratio);
    ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    const compact = size.width < COMPACT_BELOW.width || size.height < COMPACT_BELOW.height;
    draw(ctx, model, { width: size.width, height: size.height, compact });
  }, [model, draw, size, fonts]);

  return <canvas ref={ref} className="chart-canvas" />;
}
