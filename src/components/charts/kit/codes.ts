/**
 * Driver codes on a canvas: the variants of src/host/drivers.tsx, at the same sizes, so a code drawn
 * here reads the same as one in a title bar or in race control. See docs/COMPONENTS.md, "Driver codes".
 */
import { CODE_BAR, CODE_WEIGHT, styleOf, type CodeLook, type DriverStyle, type Part } from '../../../host';
import { colors } from './colors';
import { AXIS_SIZE, setFont, type Ctx } from './draw';

export interface CanvasCodeLook extends CodeLook {
  size?: number;
  /** For tone `inherit`: the colour of the text the code sits in. */
  color?: string;
  /** The bar's height. By default a pixel over the type size; a table passes its row's. */
  barHeight?: number;
  /** Where `x` is: the code's left edge (the default), its centre or its right edge. */
  align?: 'left' | 'center' | 'right';
}

const weightOf = (look: CodeLook): number => (look.strong ? CODE_WEIGHT.strong : CODE_WEIGHT.normal);
const lead = (look: CodeLook): number => ((look.variant ?? 'bar') === 'bar' ? CODE_BAR.width + CODE_BAR.gap : 0);

function toneColour(look: CanvasCodeLook): string {
  const c = colors();
  switch (look.tone ?? 'ink') {
    case 'dim':
      return c.dim;
    case 'mute':
      return c.mute;
    case 'inherit':
      return look.color ?? c.dim;
    default:
      return c.ink;
  }
}

/** How wide a code draws, bar and all. */
export function codeWidth(ctx: Ctx, style: DriverStyle, look: CanvasCodeLook = {}): number {
  setFont(ctx, look.size ?? AXIS_SIZE, weightOf(look));
  return lead(look) + ctx.measureText(style.code).width;
}

/** Draws a code centred on `y`, with `x` where `align` says. Returns its width. */
export function drawCode(ctx: Ctx, style: DriverStyle, x: number, y: number, look: CanvasCodeLook = {}): number {
  const size = look.size ?? AXIS_SIZE;
  const width = codeWidth(ctx, style, look);
  const left = look.align === 'center' ? x - width / 2 : look.align === 'right' ? x - width : x;
  if ((look.variant ?? 'bar') === 'bar') {
    const h = Math.round(look.barHeight ?? size + 1);
    ctx.fillStyle = style.colour;
    ctx.fillRect(Math.round(left), Math.round(y - h / 2), CODE_BAR.width, h);
  }
  setFont(ctx, size, weightOf(look));
  ctx.fillStyle = toneColour(look);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(style.code, left + lead(look), y);
  return width;
}

export interface PartsStyle {
  size?: number;
  /** The text's weight and colour; codes take the colour too unless `look` says otherwise. */
  weight?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** How the codes look. By default `bar`, strong, in the text's colour. */
  look?: CodeLook;
}

const codeLookFor = (s: PartsStyle): CanvasCodeLook => ({ tone: 'inherit', strong: true, ...s.look, size: s.size ?? AXIS_SIZE, color: s.color ?? colors().dim });

/** How wide text with drivers in it draws. */
export function partsWidth(ctx: Ctx, parts: readonly Part[], styles: Map<number, DriverStyle>, s: PartsStyle = {}): number {
  const look = codeLookFor(s);
  let w = 0;
  for (const p of parts) {
    if (typeof p === 'string') {
      setFont(ctx, s.size ?? AXIS_SIZE, s.weight ?? 400);
      w += ctx.measureText(p).width;
    } else w += codeWidth(ctx, styleOf(styles, p.driver), look);
  }
  return w;
}

/** Draws text with drivers in it, each driver as a code, centred on `y`. Returns its width. */
export function drawParts(ctx: Ctx, parts: readonly Part[], styles: Map<number, DriverStyle>, x: number, y: number, s: PartsStyle = {}): number {
  const width = partsWidth(ctx, parts, styles, s);
  const look = codeLookFor(s);
  let at = s.align === 'center' ? x - width / 2 : s.align === 'right' ? x - width : x;
  for (const p of parts) {
    if (typeof p === 'string') {
      setFont(ctx, s.size ?? AXIS_SIZE, s.weight ?? 400);
      ctx.fillStyle = s.color ?? colors().dim;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(p, at, y);
      at += ctx.measureText(p).width;
    } else at += drawCode(ctx, styleOf(styles, p.driver), at, y, look);
  }
  return width;
}
