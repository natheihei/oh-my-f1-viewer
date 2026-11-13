/** Where on the lap one driver gains on another: the difference in each sector over the last ten laps. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  compactSmall,
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

/** Laps shown. */
const WINDOW = 10;
/** The bars' scale, in seconds either side of the line: at least this, so noise stays small… */
const MIN_SPAN = 0.2;
/** …and at most this, so one bad sector doesn't flatten the rest. Longer bars are cut. */
const MAX_SPAN = 1;

/** Both drivers' sectors on every lap, with what makes a lap not comparable. */
export const SQL = `SELECT driver_number, lap_number, duration_sector_1, duration_sector_2, duration_sector_3, is_pit_in_lap, is_pit_out_lap, track_status
FROM lap_summary WHERE driver_number IN (?1, ?2)`;

export interface SectorModel {
  /** The laps shown, oldest first. */
  laps: number[];
  /** Per sector, per lap: the second driver's time minus the first's, so positive is the first faster. Null is left empty. */
  deltas: Array<Array<number | null>>;
  /** Why a lap is empty: either driver pitted, or the lap was neutralised. */
  skipped: Array<'PIT' | Neutral | null>;
  /** Per sector, the mean of its deltas, or null with none. */
  averages: Array<number | null>;
}

const SECTORS = ['duration_sector_1', 'duration_sector_2', 'duration_sector_3'] as const;

/**
 * The rows of `SQL` as the last ten laps both drivers have reached. A lap either spent in the pits (in
 * or out) is left empty, as is a lap under a safety car, a virtual one or a red flag, whose times
 * say nothing about pace. A sector shows once both have set it, so the lap in progress fills in.
 */
export function sectorModel(rows: ReadonlyArray<Record<string, unknown>>, [a, b]: readonly [number, number]): SectorModel {
  const byLap = (driver: number) => new Map(rows.filter((r) => num(r.driver_number) === driver && num(r.lap_number) !== null).map((r) => [num(r.lap_number)!, r]));
  const [ra, rb] = [byLap(a), byLap(b)];
  const started = (r: Record<string, unknown> | undefined) => r !== undefined && num(r.duration_sector_1) !== null;
  const both = [...ra.keys()].filter((lap) => started(ra.get(lap)) && started(rb.get(lap)));
  if (both.length === 0) return { laps: [], deltas: [[], [], []], skipped: [], averages: [null, null, null] };
  const last = Math.max(...both);
  const laps = Array.from({ length: Math.min(WINDOW, last) }, (_, i) => last - Math.min(WINDOW, last) + 1 + i);

  const skipped = laps.map((lap) => {
    const pair = [ra.get(lap), rb.get(lap)];
    if (pair.some((r) => r?.is_pit_in_lap || r?.is_pit_out_lap)) return 'PIT' as const;
    return pair.map((r) => neutralOf(r?.track_status)).find((k) => k !== null) ?? null;
  });
  const deltas = SECTORS.map((key) =>
    laps.map((lap, i) => {
      if (skipped[i]) return null;
      const [ta, tb] = [num(ra.get(lap)?.[key]), num(rb.get(lap)?.[key])];
      return ta === null || tb === null ? null : tb - ta;
    }),
  );
  const averages = deltas.map((row) => {
    const set = row.filter((d): d is number => d !== null);
    return set.length ? set.reduce((s, d) => s + d, 0) / set.length : null;
  });
  return { laps, deltas, skipped, averages };
}

/** Seconds either side of the line the bars span. */
export function spanOf(deltas: ReadonlyArray<ReadonlyArray<number | null>>): number {
  const largest = Math.max(0, ...deltas.flat().map((d) => Math.abs(d ?? 0)));
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, Math.ceil(largest * 10) / 10));
}

interface Drawn extends SectorModel {
  first: DriverStyle;
  second: DriverStyle;
}

/** A bar in a driver's colour: hollow for a team's second driver, as their lines are dashed. */
function bar(ctx: Ctx, x: number, y: number, w: number, h: number, style: DriverStyle): void {
  if (h < 0.5) return;
  if (style.dashed && w >= 4 && h >= 3) {
    ctx.strokeStyle = style.colour;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.max(1, Math.round(w) - 1), Math.max(1, Math.round(h) - 1));
    return;
  }
  ctx.fillStyle = style.colour;
  ctx.fillRect(x, y, w, h);
}

function draw(ctx: Ctx, m: Drawn, box: Box): void {
  const { width, height } = box;
  const compact = compactSmall(box);
  const c = colors();
  const left = compact ? 4 : 30;
  const side = compact ? 0 : Math.max(textWidth(ctx, 'XXX 0.000', 11, 600), textWidth(ctx, '▲ XXX faster', 10)) + 10;
  const right = width - (compact ? 4 : side + 4);
  const top = compact ? 4 : 16;
  const bottom = height - (compact ? 4 : 16);
  const rowH = (bottom - top) / 3;
  const span = spanOf(m.deltas);
  const n = Math.max(1, m.laps.length);
  const slot = (right - left) / Math.max(n, WINDOW);
  const barW = Math.max(1, slot * 0.72);

  if (!compact) {
    text(ctx, `▲ ${m.first.code} faster`, width - 4, 7, { align: 'right', color: m.first.colour });
    text(ctx, `▼ ${m.second.code} faster`, width - 4, height - 7, { align: 'right', color: m.second.colour });
    text(ctx, `bars ±${span.toFixed(1)}s${rowH < 36 ? ' · right: avg per lap' : ''}`, 4, 7, { color: c.faint, size: 9 });
  }

  m.deltas.forEach((row, k) => {
    const mid = top + rowH * k + rowH / 2;
    const half = rowH / 2 - (compact ? 1 : 3);
    hline(ctx, left, right, mid, c.faint);
    if (!compact) text(ctx, `S${k + 1}`, left - 6, mid, { align: 'right', color: c.ink, size: 11, weight: 600 });
    row.forEach((d, i) => {
      const x = left + slot * i + (slot - barW) / 2;
      if (d === null) {
        // Say why a lap is empty, once, in the middle row.
        const why = m.skipped[i];
        if (why && k === 1 && !compact && slot >= textWidth(ctx, why, 8) + 2) text(ctx, why, x + barW / 2, mid, { align: 'center', color: c.faint, size: 8 });
        return;
      }
      const h = (Math.min(Math.abs(d), span) / span) * half;
      if (d > 0) bar(ctx, x, mid - h, barW, h, m.first);
      else bar(ctx, x, mid, barW, h, m.second);
    });

    if (compact) return;
    const avg = m.averages[k];
    if (avg === null) return;
    const faster = avg >= 0 ? m.first : m.second;
    // Short rows have room for the value only; the legend above says it's per lap.
    const roomy = rowH >= 36;
    text(ctx, `${faster.code} ${Math.abs(avg).toFixed(3)}`, width - 4, roomy ? mid - 5 : mid, { align: 'right', color: faster.colour, size: 11, weight: 600 });
    if (roomy) text(ctx, 'avg per lap', width - 4, mid + 8, { align: 'right', size: 9 });
  });

  if (compact) return;
  // Lap numbers under the bars, thinned to fit.
  const every = Math.max(1, Math.ceil(textWidth(ctx, 'L00', 9) / (slot * 0.9)));
  m.laps.forEach((lap, i) => {
    if ((m.laps.length - 1 - i) % every) return;
    text(ctx, `L${lap}`, left + slot * i + slot / 2, height - 7, { align: 'center', size: 9 });
  });
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 2,
  maxItems: 2,
  description: 'The two drivers, as car numbers. A bar above the line is the first one faster.',
});

function SectorDelta({ props }: { props: { drivers: number[] } }) {
  const [a, b] = props.drivers;
  const view = useSql(SQL, [a, b]);
  const styles = useDriverStyles();
  const model = useMemo(
    () => (view.state === 'ready' ? { ...sectorModel(view.rows, [a, b]), first: styleOf(styles, a), second: styleOf(styles, b) } : null),
    [view, styles, a, b],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'sector_delta',
  title: 'Sector delta',
  description:
    'Which part of the lap one driver is gaining on another in: the difference in each of the three sectors over the last ten laps. Suggest it when the user asks in which sector or part of the lap a driver is quicker.',
  args: Type.Object({ drivers: Drivers }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 1.6, min: { width: 380, height: 190 } },
  spec: ({ drivers }) => ({ key: `sector_delta:${drivers.join('-')}`, label: `Sectors ${drivers.map(codeOf).join(' · ')}` }),
  View: SectorDelta,
});
