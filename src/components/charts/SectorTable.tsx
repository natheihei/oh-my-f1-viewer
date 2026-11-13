/**
 * Where on the lap one driver gains on another, lap by lap: a row per lap with each sector's difference written out, the lap's
 * total, and the average since either driver last stopped.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
  hline,
  neutralOf,
  num,
  styleOf,
  text,
  textWidth,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
  type Neutral,
} from './kit';

const NEEDS = ['timing' as const];

/** Laps the average counts at most, and the table shows, when neither driver has stopped. */
const WINDOW = 10;
/** A difference under this is a tie: "even". */
const EVEN = 0.02;
/** Under this a difference is drawn at half strength, and from `BIG` in bold, so a large one stands out of the column. */
const SMALL = 0.05;
const BIG = 0.2;
/** The bar behind a number is full at this many seconds. */
const FULL = 0.5;

/** Both drivers' sectors on every lap, with what makes a lap not comparable. */
export const SQL = `SELECT driver_number, lap_number, duration_sector_1, duration_sector_2, duration_sector_3, is_pit_in_lap, is_pit_out_lap, track_status
FROM lap_summary WHERE driver_number IN (?1, ?2)`;

const SECTORS = ['duration_sector_1', 'duration_sector_2', 'duration_sector_3'] as const;

/** Why a lap isn't compared: either driver pitted, it was neutralised, or it was the standing start. */
export type Skip = 'PIT' | Neutral | 'START';

export interface Row {
  lap: number;
  skip: Skip | null;
  /** On a pit lap, who was in the pits: the first or second driver, going in or coming out. */
  pits: Array<{ who: 0 | 1; way: 'in' | 'out' }>;
  /** Per sector, the first driver's time minus the second's, so negative is the first faster. Null where either has no time. */
  deltas: Array<number | null>;
  /** The three summed, once both have all three. */
  total: number | null;
  /** The lap still being driven: its sectors fill in as both set them. */
  live: boolean;
}

export interface SectorTable {
  /** Newest first: back to ten laps that count, or to the pit laps of either driver's last stop. */
  rows: Row[];
  /** Per sector, the mean over the laps that count, or null with none. */
  averages: Array<number | null>;
  total: number | null;
  /** How many laps the average is over. */
  counted: number;
  /** Whether the table stops at a stop, so the average is since it. */
  sinceStop: boolean;
  /** Where the average row goes: before this row, the first pit lap of that stop, or after the last row. */
  averageAt: number;
}

const EMPTY: SectorTable = { rows: [], averages: [null, null, null], total: null, counted: 0, sinceStop: false, averageAt: 0 };

/**
 * The rows of `SQL` for drivers `a` and `b`. Going back from the latest lap both have started, a lap counts when both
 * finished it clean: not in or out of the pits, not under a safety car, a virtual one or a red flag, and not lap 1's standing
 * start. The table goes back to ten laps that count, or stops at the pit laps of either driver's last stop, so the average is
 * never of old tyres against new.
 */
export function sectorTable(rows: ReadonlyArray<Record<string, unknown>>, [a, b]: readonly [number, number]): SectorTable {
  const byLap = (driver: number) => new Map(rows.filter((r) => num(r.driver_number) === driver && num(r.lap_number) !== null).map((r) => [num(r.lap_number)!, r]));
  const both = [byLap(a), byLap(b)];
  const started = (r: Record<string, unknown> | undefined) => r !== undefined && num(r.duration_sector_1) !== null;
  const reached = [...both[0].keys()].filter((lap) => started(both[0].get(lap)) && started(both[1].get(lap)));
  if (reached.length === 0) return EMPTY;
  const last = Math.max(...reached);

  const out: Row[] = [];
  let counted = 0;
  let stop = -1;
  for (let lap = last; lap >= 1 && counted < WINDOW; lap--) {
    const pair = both.map((m) => m.get(lap));
    const pits = pair.flatMap((r, who) => [
      ...(r?.is_pit_in_lap ? [{ who: who as 0 | 1, way: 'in' as const }] : []),
      ...(r?.is_pit_out_lap ? [{ who: who as 0 | 1, way: 'out' as const }] : []),
    ]);
    // Past the stop's pit laps, the table ends.
    if (stop >= 0 && pits.length === 0) break;
    const skip: Skip | null = pits.length ? 'PIT' : (pair.map((r) => neutralOf(r?.track_status)).find((k) => k !== null) ?? (lap === 1 ? 'START' : null));
    const deltas = SECTORS.map((key) => {
      if (skip) return null;
      const [ta, tb] = pair.map((r) => num(r?.[key]));
      return ta === null || tb === null ? null : ta - tb;
    });
    const whole = deltas.every((d) => d !== null);
    const live = lap === last && !skip && !whole;
    if (skip === 'PIT' && stop < 0) stop = out.length;
    if (!skip && whole) counted++;
    out.push({ lap, skip, pits, deltas, total: whole ? deltas.reduce((s, d) => s! + d!, 0) : null, live });
  }

  const counts = (r: Row) => !r.skip && r.total !== null;
  const averages = SECTORS.map((_, k) => {
    const set = out.filter(counts).map((r) => r.deltas[k]!);
    return set.length ? set.reduce((s, d) => s + d, 0) / set.length : null;
  });
  const total = averages.every((v) => v !== null) ? averages.reduce((s, v) => s! + v!, 0) : null;
  return { rows: out, averages, total, counted, sinceStop: stop >= 0, averageAt: stop >= 0 ? stop : out.length };
}

interface Drawn extends SectorTable {
  first: DriverStyle;
  second: DriverStyle;
}

// Type and rows as the timing tower's, at its smallest type: the numbers are read across, so the columns are as wide as
// the widest of them and no wider.
const SIZE = 11;
const PAD = 8;
const LEGEND = 18;
const HEAD = 16;
const MIN_PITCH = 16;
const MAX_PITCH = 20;
const LAP_W = 44;
const NUM_W = 60;
const THUMBNAIL_BELOW = 150;
/** Ten laps that count, the lap in progress, the average and a stop's in- and out-lap. */
const MOST_ROWS = WINDOW + 4;

const tableWidth = PAD * 2 + LAP_W + NUM_W * 4;
const heightAt = (rows: number, pitch: number): number => LEGEND + HEAD + rows * pitch + PAD;
const LEAST = { width: tableWidth, height: heightAt(MOST_ROWS, MIN_PITCH) };
const MOST = { width: tableWidth, height: heightAt(MOST_ROWS, MAX_PITCH) };

const thumbnail = (height: number): boolean => height < THUMBNAIL_BELOW;
/** The rows drawn, the average among them. */
const lines = (m: SectorTable): number => m.rows.length + 1;
const pitchOf = (m: SectorTable, height: number): number => Math.min(MAX_PITCH, Math.max(MIN_PITCH, (height - LEGEND - HEAD - PAD) / lines(m)));

/** The tile itself while the table fits it, and past its bottom or right edge once rows stop shrinking. */
export function tableExtent(m: Drawn, { width, height }: Box): { width: number; height: number } {
  if (thumbnail(height)) return { width, height };
  return { width: Math.max(width, LEAST.width), height: Math.max(height, Math.ceil(heightAt(lines(m), pitchOf(m, height)))) };
}

/** A difference as read: "−0.26" in the gain colour where the first driver is faster, "+0.10" in the loss colour where slower. */
function cell(ctx: Ctx, v: number | null, right: number, y: number, pitch: number, size: number, weight?: number): void {
  const c = colors();
  if (v === null) return;
  const a = Math.abs(v);
  if (a < EVEN) {
    text(ctx, 'even', right, y, { align: 'right', color: c.dim, size, weight: weight ?? 400 });
    return;
  }
  const colour = v < 0 ? c.gain : c.loss;
  // The bar behind gives the column back its shape.
  const len = (Math.min(a, FULL) / FULL) * (NUM_W - 10);
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = colour;
  ctx.fillRect(right + 2 - len, y - pitch / 2 + 3, len, pitch - 6);
  ctx.globalAlpha = weight === undefined && a < SMALL ? 0.55 : 1;
  text(ctx, `${v < 0 ? '−' : '+'}${a.toFixed(2)}`, right, y, { align: 'right', color: colour, size, weight: weight ?? (a >= BIG ? 700 : 400) });
  ctx.globalAlpha = 1;
}

function draw(ctx: Ctx, m: Drawn, { width, height }: Box): void {
  const c = colors();
  const small = thumbnail(height);
  const size = small ? 9 : SIZE;
  const pitch = small ? Math.max(11, Math.min(MIN_PITCH, (height - 4) / lines(m))) : pitchOf(m, height);
  const left = small ? 4 : PAD;
  const right = (k: number) => left + LAP_W + NUM_W * (k + 1) - 2;
  const end = right(3) + 2;
  let y = small ? 2 : 0;

  if (!small) {
    const mid = LEGEND / 2;
    let x = left;
    for (const [s, colour, weight] of [
      [m.first.code, m.first.colour, 700],
      [' vs ', c.dim, 400],
      [m.second.code, m.second.colour, 700],
    ] as const) {
      text(ctx, s, x, mid, { color: colour, size: SIZE, weight });
      x += textWidth(ctx, s, SIZE, weight);
    }
    const basis = m.counted ? `avg ${m.counted} lap${m.counted === 1 ? '' : 's'}${m.sinceStop ? ' since pit' : ''}` : m.sinceStop ? 'no lap since pit' : '';
    text(ctx, basis, end, mid, { align: 'right', color: c.dim, size: SIZE });
    const head = LEGEND + HEAD / 2;
    text(ctx, 'LAP', left, head, { color: c.mute, size: SIZE, weight: 600 });
    ['S1', 'S2', 'S3', 'LAP'].forEach((h, k) => text(ctx, h, right(k), head, { align: 'right', color: c.mute, size: SIZE, weight: 600 }));
    y = LEGEND + HEAD;
    hline(ctx, left, end, y, c.line);
  }

  const average = () => {
    ctx.fillStyle = c.quiet;
    ctx.fillRect(left, y + 1, end - left, pitch - 1);
    const mid = y + pitch / 2 + 0.5;
    text(ctx, 'AVG', left, mid, { color: c.ink, size, weight: 700 });
    if (m.counted === 0) text(ctx, '–', right(3), mid, { align: 'right', color: c.faint, size });
    m.averages.forEach((v, k) => cell(ctx, v, right(k), mid, pitch, size, 700));
    cell(ctx, m.total, right(3), mid, pitch, size, 700);
    y += pitch;
    hline(ctx, left, end, y, c.line);
  };

  m.rows.forEach((row, i) => {
    if (i === m.averageAt) average();
    if (small && y + pitch > height) return;
    const mid = y + pitch / 2 + 0.5;
    if (row.live) {
      ctx.fillStyle = c.select;
      ctx.fillRect(left, y + 1, end - left, pitch - 1);
    } else if (i > 0 && i !== m.averageAt && !small) hline(ctx, left, end, y, c.quiet);
    text(ctx, `L${row.lap}`, left, mid, { color: row.live ? c.ink : c.dim, size, weight: row.live ? 600 : 400 });
    if (row.skip) {
      const note =
        row.skip === 'PIT'
          ? ['PIT', ...row.pits.map((p) => `${(p.who ? m.second : m.first).code} ${p.way}`)].join(' · ')
          : `${row.skip} · not counted`;
      text(ctx, note, left + LAP_W, mid, { color: c.mute, size });
    } else {
      // A sector still being driven is "…"; one the feed never sent is a dash.
      row.deltas.forEach((d, k) => {
        if (d === null) text(ctx, row.live ? '…' : '–', right(k), mid, { align: 'right', color: row.live ? c.mute : c.faint, size });
        else cell(ctx, d, right(k), mid, pitch, size);
      });
      if (row.total !== null) cell(ctx, row.total, right(3), mid, pitch, size, 600);
      else text(ctx, row.live ? '…' : '–', right(3), mid, { align: 'right', color: row.live ? c.mute : c.faint, size });
    }
    y += pitch;
  });
  if (m.averageAt >= m.rows.length && m.rows.length && (!small || y + pitch <= height)) average();
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 2,
  maxItems: 2,
  description: 'The two drivers, as car numbers. Each difference is the first driver against the second: negative is the first faster.',
});

function SectorTableView({ props }: { props: { drivers: number[] } }) {
  const [a, b] = props.drivers;
  const view = useSql(SQL, [a, b]);
  const styles = useDriverStyles();
  const model = useMemo(
    () => (view.state === 'ready' ? { ...sectorTable(view.rows, [a, b]), first: styleOf(styles, a), second: styleOf(styles, b) } : null),
    [view, styles, a, b],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} extent={tableExtent} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'sector_table',
  title: 'Sector table',
  description:
    'Where on the lap one driver gains on another, lap by lap: a row per lap with the time each of the three sectors gained or lost, the lap total, and the average since either driver last stopped. Suggest it when the user asks in which sector or part of the lap one driver is quicker than another, or by how much; gap_evolution is for the gap between them on the road.',
  args: Type.Object({ drivers: Drivers }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: Math.round((MOST.width / MOST.height) * 100) / 100, min: LEAST },
  fit: MOST,
  spec: ({ drivers }) => ({ key: `sector_table:${drivers.join('-')}`, label: `Sectors ${drivers.map(codeOf).join(' · ')}` }),
  View: SectorTableView,
});
