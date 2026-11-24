/** Small Canvas 2D helpers every chart draws with: text, rules, lines and axes, in the theme. */
import { colors, DASH } from './colors';
import { spreadLabels } from './labels';
import type { Scale } from './scale';

export type Ctx = CanvasRenderingContext2D;

/**
 * The app's monospace font, for canvas text: Menlo on macOS, where it ships with the system, and JetBrains Mono,
 * bundled, elsewhere. The same as --font-mono in src/styles.css.
 */
export const MONO_FAMILY = 'Menlo, "JetBrains Mono", ui-monospace, monospace';

/**
 * A character's advance in MONO_FAMILY as a share of its size, for widths worked out before there's a canvas:
 * Menlo's, 0.602, the wider of the two (JetBrains Mono's is 0.6), so a width from it fits either.
 */
export const MONO_ADVANCE = 0.602;

/** Axis text size. Values are ink, everything around them dim. */
export const AXIS_SIZE = 10;

export function setFont(ctx: Ctx, size = AXIS_SIZE, weight = 400): void {
  ctx.font = `${weight} ${size}px ${MONO_FAMILY}`;
}

export interface TextStyle {
  color?: string;
  size?: number;
  weight?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
}

export function text(ctx: Ctx, value: string, x: number, y: number, style: TextStyle = {}): void {
  setFont(ctx, style.size, style.weight);
  ctx.fillStyle = style.color ?? colors().dim;
  ctx.textAlign = style.align ?? 'left';
  ctx.textBaseline = style.baseline ?? 'middle';
  ctx.fillText(value, x, y);
}

/** Width of `value` in the given size. */
export function textWidth(ctx: Ctx, value: string, size = AXIS_SIZE, weight = 400): number {
  setFont(ctx, size, weight);
  return ctx.measureText(value).width;
}

/** `value`, cut with an ellipsis to fit `width`, or "" if not even one character does. */
export function fitText(ctx: Ctx, value: string, width: number, size = AXIS_SIZE, weight = 400): string {
  if (textWidth(ctx, value, size, weight) <= width) return value;
  for (let n = value.length - 1; n > 0; n--) {
    const cut = `${value.slice(0, n)}…`;
    if (textWidth(ctx, cut, size, weight) <= width) return cut;
  }
  return '';
}

// Whole pixels plus a half, so one-pixel rules stay sharp.
const crisp = (v: number) => Math.round(v) + 0.5;

export function hline(ctx: Ctx, x0: number, x1: number, y: number, color = colors().line, dash: number[] = []): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, crisp(y));
  ctx.lineTo(x1, crisp(y));
  ctx.stroke();
  ctx.setLineDash([]);
}

export function vline(ctx: Ctx, x: number, y0: number, y1: number, color = colors().line, dash: number[] = []): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(crisp(x), y0);
  ctx.lineTo(crisp(x), y1);
  ctx.stroke();
  ctx.setLineDash([]);
}

export interface LineStyle {
  color: string;
  width?: number;
  /** A team's second driver: drawn with `DASH`. */
  dashed?: boolean;
}

/** A line through the points. A null point breaks it, so a gap in the data shows as one. */
export function polyline(ctx: Ctx, points: ReadonlyArray<readonly [number, number] | null>, style: LineStyle): void {
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width ?? 1.2;
  ctx.lineJoin = 'round';
  ctx.setLineDash(style.dashed ? DASH : []);
  ctx.beginPath();
  let open = false;
  for (const p of points) {
    if (!p) {
      open = false;
      continue;
    }
    if (open) ctx.lineTo(p[0], p[1]);
    else ctx.moveTo(p[0], p[1]);
    open = true;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export function dot(ctx: Ctx, x: number, y: number, radius: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** Labels down the left of a plot, each with a grid line across it: only labelled values get a line. */
export function yAxis(
  ctx: Ctx,
  options: { scale: Scale; values: number[]; x0: number; x1: number; format?: (v: number) => string; grid?: boolean },
): void {
  const { scale, values, x0, x1, format = String, grid = true } = options;
  for (const v of values) {
    const y = scale(v);
    if (grid) hline(ctx, x0, x1, y);
    text(ctx, format(v), x0 - 5, y, { align: 'right' });
  }
}

/** Labels along the bottom of a plot, centred under their values. */
export function xAxis(ctx: Ctx, options: { scale: Scale; values: number[]; y: number; format?: (v: number) => string }): void {
  const { scale, values, y, format = String } = options;
  for (const v of values) text(ctx, format(v), scale(v), y, { align: 'center' });
}

/** Labels at the ends of lines, pushed apart so they don't overlap. */
export function endLabels(
  ctx: Ctx,
  items: ReadonlyArray<{ y: number; label: string; color: string }>,
  x: number,
  options: { gap?: number; lo?: number; hi?: number; size?: number } = {},
): void {
  const { gap = 11, lo, hi, size = AXIS_SIZE } = options;
  const ys = spreadLabels(
    items.map((i) => i.y),
    gap,
    lo,
    hi,
  );
  items.forEach((item, i) => text(ctx, item.label, x, ys[i], { color: item.color, size }));
}
