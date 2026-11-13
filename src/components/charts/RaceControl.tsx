/** Race control's messages as issued, newest first, each with a bar in its flag's colour. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  compactSmall,
  colors,
  fitText,
  num,
  styleOf,
  text,
  textWidth,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

export const SQL = `SELECT date, lap_number, category, flag, driver_number, message FROM race_control ORDER BY date DESC`;

/** What a message's bar shows: the flag, or the safety car's yellow, or nothing in particular. */
export type Signal = 'green' | 'yellow' | 'red' | 'blue' | 'blackwhite' | 'black' | 'chequered' | 'note';

export type Message =
  | { kind: 'message'; lap: number | null; signal: Signal; text: string }
  /** A run of blue flags between other messages, collapsed into one line. */
  | { kind: 'blue'; lap: number | null; count: number; drivers: number[] };

/** The signal for a race control row, from F1's `category` and `flag`. */
export function signalOf(r: Record<string, unknown>): Signal {
  const flag = typeof r.flag === 'string' ? r.flag.toUpperCase() : '';
  if (r.category === 'SafetyCar') return 'yellow';
  if (flag === 'GREEN' || flag === 'CLEAR') return 'green';
  if (flag.includes('YELLOW')) return 'yellow';
  if (flag === 'RED') return 'red';
  if (flag === 'BLUE') return 'blue';
  if (flag === 'BLACK AND WHITE') return 'blackwhite';
  if (flag.startsWith('BLACK')) return 'black';
  if (flag === 'CHEQUERED') return 'chequered';
  return 'note';
}

/**
 * The rows of `SQL`, newest first, as lines. Blue flags come many at a time, so unless `blue` is set,
 * each run of them between other messages becomes one line that counts them.
 */
export function messagesModel(rows: ReadonlyArray<Record<string, unknown>>, blue = false): Message[] {
  const out: Message[] = [];
  for (const r of rows) {
    const lap = num(r.lap_number);
    const signal = signalOf(r);
    if (signal === 'blue' && !blue) {
      const last = out.at(-1);
      const driver = num(r.driver_number);
      if (last?.kind === 'blue') {
        last.count += 1;
        if (driver !== null && !last.drivers.includes(driver)) last.drivers.push(driver);
      } else out.push({ kind: 'blue', lap, count: 1, drivers: driver === null ? [] : [driver] });
      continue;
    }
    out.push({ kind: 'message', lap, signal, text: typeof r.message === 'string' ? r.message : '' });
  }
  return out;
}

// Flags in their conventional colours. These are flags, not emphasis: the accent never appears.
const FLAG: Record<Exclude<Signal, 'note'>, string> = {
  green: '#3fb54a',
  yellow: '#ffd12e',
  red: '#e8202a',
  blue: '#3d8fe0',
  blackwhite: '#e7e7e7',
  black: '#e7e7e7',
  chequered: '#e7e7e7',
};

/** The flag bar, `w` wide from `top` for `h`. */
function flagBar(ctx: Ctx, signal: Signal, x: number, top: number, w: number, h: number): void {
  const c = colors();
  if (signal === 'note') {
    ctx.fillStyle = c.line;
    ctx.fillRect(x, top, w, h);
    return;
  }
  ctx.fillStyle = FLAG[signal];
  ctx.fillRect(x, top, w, h);
  // Black and white is split on the diagonal, as the flag is; black is outlined; chequered is in squares.
  if (signal === 'blackwhite') {
    ctx.fillStyle = '#000';
    ctx.fillRect(x, top + h / 2, w, h / 2);
    ctx.strokeStyle = c.dim;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);
  } else if (signal === 'black') {
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 1, top + 1, w - 2, h - 2);
  } else if (signal === 'chequered') {
    const cell = Math.max(1.5, w / 2);
    ctx.fillStyle = '#000';
    for (let row = 0; row * cell < h; row++) ctx.fillRect(x + (row % 2) * cell, top + row * cell, cell, Math.min(cell, h - row * cell));
  }
}

/** `value` broken into at most `lines` lines that fit `width`, the last cut with an ellipsis. */
export function wrap(measure: (s: string) => number, value: string, width: number, lines: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    // The last line takes the rest, for the caller to cut.
    if (out.length === lines - 1) {
      out.push([line, ...words.slice(i)].filter(Boolean).join(' '));
      return out;
    }
    const next = line ? `${line} ${words[i]}` : words[i];
    if (!line || measure(next) <= width) line = next;
    else {
      out.push(line);
      line = words[i];
    }
  }
  if (line) out.push(line);
  return out;
}

interface Drawn {
  messages: Message[];
  styles: Map<number, DriverStyle>;
}

function draw(ctx: Ctx, m: Drawn, box: Box): void {
  const { width, height } = box;
  const compact = compactSmall(box);
  const c = colors();
  const pad = compact ? 4 : 8;
  const size = compact ? 8 : 10;
  const line = compact ? 10 : 13;
  const gap = compact ? 3 : 6;
  const lapW = compact ? 0 : textWidth(ctx, 'L00', 9) + 6;
  const barX = pad + lapW;
  const textX = barX + (compact ? 6 : 9);
  const textW = width - pad - textX;
  const lines = compact ? 1 : 2;

  let top = compact ? 4 : 6;
  for (const [i, msg] of m.messages.entries()) {
    const body =
      msg.kind === 'blue'
        ? `${msg.count} BLUE FLAG${msg.count === 1 ? '' : 'S'}${msg.drivers.length ? `: ${msg.drivers.map((d) => styleOf(m.styles, d).code).join(', ')}` : ''}`
        : msg.text;
    const signal = msg.kind === 'blue' ? 'blue' : msg.signal;
    const wrapped = wrap((s) => textWidth(ctx, s, size), body, textW, lines);
    const last = wrapped.length - 1;
    wrapped[last] = fitText(ctx, wrapped[last], textW, size);
    const h = wrapped.length * line;
    if (top + h > height - 2) break;
    flagBar(ctx, signal, barX, top + 1, compact ? 2 : 3, h - 2);
    if (!compact && msg.lap !== null) text(ctx, `L${msg.lap}`, pad, top + line / 2, { size: 9 });
    // The newest in ink, the rest dim, so the latest reads first.
    const color = i === 0 ? c.ink : c.dim;
    wrapped.forEach((t, k) => text(ctx, t, textX, top + line / 2 + k * line, { color, size, weight: i === 0 ? 500 : 400 }));
    top += h + gap;
  }
}

function RaceControl({ props }: { props: { blue_flags?: boolean } }) {
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const blue = props.blue_flags ?? false;
  const model = useMemo(() => (view.state === 'ready' ? { messages: messagesModel(view.rows, blue), styles } : null), [view, styles, blue]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'race_control',
  title: 'Race control',
  description:
    "Race control's messages as they were issued: flags, safety cars, investigations, penalties and deleted laps. Suggest it when the user asks what a flag was for, or what happened.",
  args: Type.Object({
    blue_flags: Type.Optional(Type.Boolean({ description: 'Show each blue flag on its own line. Left out, runs of them are counted on one line.' })),
  }),
  needs: NEEDS,
  size: { aspect: 1.6, min: { width: 380, height: 150 } },
  spec: ({ blue_flags }) => ({ key: blue_flags ? 'race_control:blue' : 'race_control', label: 'Race control' }),
  View: RaceControl,
});
