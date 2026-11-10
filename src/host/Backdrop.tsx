/**
 * The background in the gaps between tiles: a canvas under the grid, painted by the registered
 * background that `live.background` names. Tiles are opaque, so it only shows where there are none.
 *
 * It paints only when something changes, and every frame only while the background animates with
 * its settings. The browser stops animation frames while the window is hidden, and with reduced
 * motion it paints still frames, with the clock held at 0.
 */
import { useEffect, useRef } from 'react';
import { GRID_COLUMNS, GRID_ROWS } from '../layout/model';
import { backgroundOf, NO_BACKGROUND, useBackground, type BackgroundDefinition, type BackgroundParams } from './backgrounds';
import { useLive } from './live';

export function Backdrop() {
  const style = useLive((s) => s.background.style);
  const definition = style === NO_BACKGROUND ? undefined : backgroundOf(style);
  useEffect(() => {
    if (!definition) useBackground.setState({ unavailable: null });
  }, [definition]);
  // Keyed by style, so each background's own data hook is only ever called by its own painter.
  return definition ? <Painter key={definition.name} definition={definition} /> : null;
}

function Painter({ definition }: { definition: BackgroundDefinition }) {
  const params = useLive((s) => s.background.params[definition.name]);
  const data = definition.useData?.(params);
  const unavailable = definition.unavailable?.(data) ?? null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef({ params, data, unavailable });
  latest.current = { params, data, unavailable };
  const invalidateRef = useRef<() => void>(() => {});

  useEffect(() => {
    useBackground.setState({ unavailable });
  }, [unavailable]);
  useEffect(() => () => useBackground.setState({ unavailable: null }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const start = performance.now();
    let size = { width: 0, height: 0 };
    let ratio = 1;
    let prepared: unknown;
    let preparedFor = '';
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;

    const paint = () => {
      frame = 0;
      const { params, data, unavailable } = latest.current;
      if (!params) return;
      const key = `${size.width}x${size.height}:${JSON.stringify(params)}`;
      if (key !== preparedFor) {
        prepared = definition.prepare?.(size, params);
        preparedFor = key;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
      if (unavailable || size.width === 0) return;
      const t = reduce.matches ? 0 : (performance.now() - start) / 1000;
      const cell = { w: size.width / GRID_COLUMNS, h: size.height / GRID_ROWS };
      definition.draw(ctx, { width: size.width, height: size.height, cell, t, pointer }, params, prepared, data);
      if (!reduce.matches && definition.animated(params)) invalidate();
    };
    const invalidate = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    invalidateRef.current = invalidate;

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      ratio = Math.min(2, window.devicePixelRatio || 1);
      size = { width: box.width, height: box.height };
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const follows = () => definition.followsPointer?.(latest.current.params as BackgroundParams) ?? false;
    const onMove = (e: PointerEvent) => {
      if (!follows()) return;
      const box = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
      invalidate();
    };
    const onLeave = (e: PointerEvent) => {
      if (e.relatedTarget != null || !follows()) return;
      pointer = null;
      invalidate();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerout', onLeave);
    reduce.addEventListener('change', invalidate);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onLeave);
      reduce.removeEventListener('change', invalidate);
    };
  }, [definition]);

  // Settings or data changed: paint again.
  useEffect(() => invalidateRef.current(), [params, data, unavailable]);

  return <canvas ref={canvasRef} className="backdrop" data-testid="backdrop" aria-hidden="true" />;
}
