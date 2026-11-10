/** Every driver's gap to the leader at the end of each lap, one line each, leader on top. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql } from '../../host';
import {
  axisLaps,
  ChartCanvas,
  ChartFrame,
  codeOf,
  drawBands,
  lapAxis,
  linear,
  median,
  neutralBands,
  niceCeil,
  num,
  polyline,
  spreadLabels,
  styleOf,
  text,
  ticks,
  useDriverStyles,
  yAxis,
  type Band,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/**
 * Each completed lap's end, and its status for the shading, and the lap a car retired on, which never
 * ends. The gap comes from lap ends rather than `gap_to_leader`, which turns into text such as "+1 LAP" for a lapped car.
 */
export const SQL = `SELECT driver_number, lap_number, date_end, track_status, is_out FROM lap_summary WHERE date_end IS NOT NULL OR is_out`;

export interface TraceLine {
  driver: number;
  /** Seconds behind the leader at the end of each lap, by lap. A missing lap breaks the line. */
  points: Array<{ lap: number; gap: number }>;
}

export interface TraceModel {
  /** In running order at each driver's latest lap: the leader first. */
  lines: TraceLine[];
  bands: Band[];
  /** The latest lap anyone has finished. */
  lap: number;
  /** Where the y axis ends, in seconds: cars further back run off the bottom. */
  yMax: number;
}

/** Share of the cars on the lead lap that the y axis fits: the rest run off the bottom with an arrow. */
const FIT = 0.6;
/**
 * The y axis's end: the first `FIT` of the running cars on the lead lap, with room, and the highlighted
 * drivers. Lapped cars and those just out of the pits can run off the bottom. Retired cars, in `out`, don't count.
 */
function traceRange(lines: TraceLine[], out: ReadonlySet<number>, lapTime: number, highlight: readonly number[]): number {
  const running = lines.filter((l) => !out.has(l.driver)).map((l) => l.points.at(-1)!).filter((p) => p.gap < lapTime);
  const sorted = running.map((p) => p.gap).sort((a, b) => a - b);
  const most = sorted[Math.max(0, Math.ceil(sorted.length * FIT) - 1)] ?? 0;
  const extra = lines.filter((l) => highlight.includes(l.driver)).map((l) => l.points.at(-1)!.gap);
  return niceCeil(Math.max(10, most * 1.1, ...extra), 6);
}

/**
 * The rows of `SQL` as one line per driver. A lap's leader is whoever ended it first, and each car's
 * gap is how much later it ended the same lap. `highlight` keeps those drivers' latest gaps in range.
 */
export function traceModel(all: ReadonlyArray<Record<string, unknown>>, highlight: readonly number[] = []): TraceModel {
  const out = new Set(all.filter((r) => r.is_out).map((r) => num(r.driver_number)).filter((d): d is number => d !== null));
  const rows = all.filter((r) => num(r.date_end) !== null);
  const first = new Map<number, number>();
  for (const r of rows) {
    const lap = num(r.lap_number);
    const end = num(r.date_end);
    if (lap === null || end === null) continue;
    first.set(lap, Math.min(first.get(lap) ?? Infinity, end));
  }
  const byDriver = new Map<number, TraceLine['points']>();
  let lap = 0;
  for (const r of rows) {
    const driver = num(r.driver_number);
    const n = num(r.lap_number);
    const end = num(r.date_end);
    if (driver === null || n === null || end === null) continue;
    const points = byDriver.get(driver) ?? [];
    points.push({ lap: n, gap: (end - first.get(n)!) / 1000 });
    byDriver.set(driver, points);
    lap = Math.max(lap, n);
  }
  const lines = [...byDriver].map(([driver, points]) => ({ driver, points: points.sort((a, b) => a.lap - b.lap) }));
  // Further round the race first, then closer to the leader.
  lines.sort((a, b) => b.points.at(-1)!.lap - a.points.at(-1)!.lap || a.points.at(-1)!.gap - b.points.at(-1)!.gap);
  // A lap's length is the time between leaders crossing the line; lapped cars are a lap or more behind.
  const ends = [...first].sort((a, b) => a[0] - b[0]);
  const lapTime = median(ends.slice(1).flatMap(([n, t], i) => (ends[i][0] === n - 1 ? [(t - ends[i][1]) / 1000] : []))) ?? Infinity;
  return { lines, bands: neutralBands(rows), lap, yMax: traceRange(lines, out, lapTime, highlight) };
}

interface Drawn extends TraceModel {
  styles: Map<number, DriverStyle>;
  total: number | null;
  highlight: readonly number[];
}

const LABEL_GAP = 10;

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const left = compact ? 4 : 34;
  const right = width - (compact ? 4 : 44);
  const top = compact ? 4 : 8;
  const bottom = height - (compact ? 4 : 20);
  const laps = axisLaps(m.lap, m.total);
  const x = linear([0, laps], [left, right]);
  const y = linear([0, m.yMax], [top, bottom]);
  const some = m.highlight.length > 0;

  drawBands(ctx, { scale: x, bands: m.bands, top, bottom, labels: !compact });
  if (!compact) {
    const values = ticks(0, m.yMax, Math.max(2, Math.floor((bottom - top) / 32)));
    yAxis(ctx, { scale: y, values, x0: left, x1: right, format: (v) => (v ? `+${v}` : '0') });
    lapAxis(ctx, { scale: x, laps, y: height - 8 });
  }

  // Highlighted drivers last, so they sit on top.
  const lit = (driver: number) => m.highlight.includes(driver);
  const order = [...m.lines].sort((a, b) => Number(lit(a.driver)) - Number(lit(b.driver)));
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 1, right - left + 2, bottom - top + 2);
  ctx.clip();
  for (const line of order) {
    const style = styleOf(m.styles, line.driver);
    const path: Array<readonly [number, number] | null> = [];
    line.points.forEach((p, i) => {
      if (i && p.lap !== line.points[i - 1].lap + 1) path.push(null);
      // Far off the bottom is still off the bottom: keeps the clipped line's slope sane.
      path.push([x(p.lap), y(Math.min(p.gap, m.yMax * 1.5))]);
    });
    ctx.globalAlpha = some && !lit(line.driver) ? 0.4 : 1;
    polyline(ctx, path, { color: style.colour, dashed: style.dashed, width: lit(line.driver) ? (compact ? 1.8 : 2.4) : compact ? 0.8 : 1.1 });
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  if (compact) return;

  // Codes beside each line's end, with an arrow at the bottom for a car off the scale. With no room
  // for all, the highlighted drivers come first, then the running order.
  const room = Math.floor((bottom - top - 3) / LABEL_GAP) + 1;
  const labelX = x(m.lap) + 5;
  const shown = [...m.lines].sort((a, b) => Number(lit(b.driver)) - Number(lit(a.driver))).slice(0, room);
  const wanted = shown.map((line) => Math.min(y(line.points.at(-1)!.gap), bottom));
  const ys = spreadLabels(wanted, LABEL_GAP, top + 3, bottom);
  shown.forEach((line, i) => {
    const style = styleOf(m.styles, line.driver);
    const off = line.points.at(-1)!.gap > m.yMax;
    ctx.globalAlpha = some && !lit(line.driver) ? 0.5 : 1;
    text(ctx, off ? `${style.code}↓` : style.code, labelX, ys[i], { color: style.colour, size: 9, weight: lit(line.driver) ? 600 : 400 });
  });
  ctx.globalAlpha = 1;
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 6,
  description: 'Drivers to draw thicker, as car numbers. Left out, every line is the same.',
});

function RaceTrace({ props }: { props: { drivers?: number[] } }) {
  const key = props.drivers?.join(',') ?? '';
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const total = useLive((live) => (live.sessionData.state === 'ready' ? (live.sessionData.lapCount?.total ?? null) : null));
  const model = useMemo(() => {
    if (view.state !== 'ready') return null;
    const highlight = key ? key.split(',').map(Number) : [];
    return { ...traceModel(view.rows, highlight), styles, total, highlight };
  }, [view, styles, total, key]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'race_trace',
  title: 'Race trace',
  description:
    "Every driver's gap to the leader, lap by lap, as one line each. It shows how the race has unfolded: who is pulling away, who pitted, where a safety car closed the field up. Suggest it for the story of the race so far.",
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 16 / 9, min: [12, 7] },
  spec: ({ drivers }) => ({
    key: `race_trace:${drivers?.join('-') ?? 'all'}`,
    label: drivers?.length ? `Race trace ${drivers.map(codeOf).join(' · ')}` : 'Race trace',
  }),
  View: RaceTrace,
});
