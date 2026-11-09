/** Each driver's position at the end of every lap, from the grid, as step lines with position 1 on top. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type StartingGridEntry } from '../../host';
import {
  axisLaps,
  ChartCanvas,
  ChartFrame,
  codeOf,
  drawBands,
  lapAxis,
  linear,
  neutralBands,
  num,
  polyline,
  spreadLabels,
  styleOf,
  text,
  useDriverStyles,
  type Band,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/** Each completed lap's position as the car crossed the line, and its status for the shading. */
export const SQL = `SELECT driver_number, lap_number, position, track_status FROM lap_summary WHERE date_end IS NOT NULL`;

export interface PositionLine {
  driver: number;
  /** Lap 0 is the grid slot. A missing lap breaks the line. */
  points: Array<{ lap: number; position: number }>;
}

export interface PositionModel {
  /** In order of the latest position, cars further round first. */
  lines: PositionLine[];
  bands: Band[];
  /** The latest lap anyone has finished. */
  lap: number;
  /** The lowest position on the axis: the size of the field. */
  cars: number;
}

/** The rows of `SQL`, with the grid as lap 0, as one line per driver. */
export function positionModel(rows: ReadonlyArray<Record<string, unknown>>, grid: readonly StartingGridEntry[]): PositionModel {
  const byDriver = new Map<number, PositionLine['points']>();
  for (const g of grid) if (g.position != null) byDriver.set(g.driver_number, [{ lap: 0, position: g.position }]);
  let lap = 0;
  let cars = grid.length;
  for (const r of rows) {
    const driver = num(r.driver_number);
    const n = num(r.lap_number);
    const position = num(r.position);
    if (driver === null || n === null || position === null) continue;
    const points = byDriver.get(driver) ?? [];
    points.push({ lap: n, position });
    byDriver.set(driver, points);
    lap = Math.max(lap, n);
    cars = Math.max(cars, position);
  }
  const lines = [...byDriver].map(([driver, points]) => ({ driver, points: points.sort((a, b) => a.lap - b.lap) }));
  cars = Math.max(cars, lines.length);
  lines.sort((a, b) => b.points.at(-1)!.lap - a.points.at(-1)!.lap || a.points.at(-1)!.position - b.points.at(-1)!.position);
  return { lines, bands: neutralBands(rows), lap, cars };
}

interface Drawn extends PositionModel {
  styles: Map<number, DriverStyle>;
  total: number | null;
  highlight: readonly number[];
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const left = compact ? 4 : 24;
  const right = width - (compact ? 4 : 40);
  const top = compact ? 5 : 10;
  const bottom = height - (compact ? 5 : 24);
  const laps = axisLaps(m.lap, m.total);
  const x = linear([0, laps], [left, right]);
  const y = linear([1, Math.max(2, m.cars)], [top, bottom]);
  const pitch = (bottom - top) / Math.max(1, m.cars - 1);
  const lit = (driver: number) => m.highlight.includes(driver);
  const some = m.highlight.length > 0;

  drawBands(ctx, { scale: x, bands: m.bands, top: top - 6, bottom: bottom + 6, labels: false });
  if (!compact) {
    // Every position when there's room, else 1 and every fifth.
    const every = pitch >= 10 ? 1 : pitch >= 5 ? 5 : 10;
    for (let p = 1; p <= m.cars; p++) if (p === 1 || p % every === 0) text(ctx, String(p), left - 6, y(p), { align: 'right' });
    lapAxis(ctx, { scale: x, laps, y: height - 8 });
  }

  const order = [...m.lines].sort((a, b) => Number(lit(a.driver)) - Number(lit(b.driver)));
  for (const line of order) {
    const style = styleOf(m.styles, line.driver);
    const path: Array<readonly [number, number] | null> = [];
    line.points.forEach((p, i) => {
      const before = line.points[i - 1];
      if (before && before.lap === p.lap - 1) {
        // The step sits halfway through the lap, so a lap's line is flat at the place it ended in.
        const mid = x(p.lap - 0.5);
        path.push([mid, y(before.position)], [mid, y(p.position)]);
      } else if (i) path.push(null);
      path.push([x(p.lap), y(p.position)]);
    });
    ctx.globalAlpha = some && !lit(line.driver) ? 0.4 : 1;
    polyline(ctx, path, { color: style.colour, dashed: style.dashed, width: lit(line.driver) ? (compact ? 1.8 : 2.4) : compact ? 0.9 : 1.3 });
  }
  ctx.globalAlpha = 1;
  if (compact) return;

  // Codes at each line's latest position, beside the latest lap.
  const size = Math.min(9, Math.max(7, Math.floor(pitch * 0.9)));
  const ys = spreadLabels(
    m.lines.map((l) => y(l.points.at(-1)!.position)),
    Math.min(10, pitch),
    top,
    bottom,
  );
  m.lines.forEach((line, i) => {
    const style = styleOf(m.styles, line.driver);
    ctx.globalAlpha = some && !lit(line.driver) ? 0.5 : 1;
    text(ctx, style.code, x(m.lap) + 5, ys[i], { color: style.colour, size, weight: lit(line.driver) ? 600 : 400 });
  });
  ctx.globalAlpha = 1;
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 6,
  description: 'Drivers to draw thicker, as car numbers. Left out, every line is the same.',
});

const NO_GRID: StartingGridEntry[] = [];

function PositionChart({ props }: { props: { drivers?: number[] } }) {
  const key = props.drivers?.join(',') ?? '';
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const total = useLive((live) => (live.sessionData.state === 'ready' ? (live.sessionData.lapCount?.total ?? null) : null));
  const grid = useLive((live) => (live.sessionData.state === 'ready' ? live.sessionData.startingGrid : NO_GRID));
  const model = useMemo(() => {
    if (view.state !== 'ready') return null;
    const highlight = key ? key.split(',').map(Number) : [];
    return { ...positionModel(view.rows, grid), styles, total, highlight };
  }, [view, grid, styles, total, key]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'position_chart',
  title: 'Positions',
  description:
    "Each driver's position at the end of every lap, starting from the grid. Suggest it when the user asks who has gained or lost places, or how a driver got to where they are.",
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 16 / 9, min: [12, 7] },
  spec: ({ drivers }) => ({
    key: `position_chart:${drivers?.join('-') ?? 'all'}`,
    label: drivers?.length ? `Positions ${drivers.map(codeOf).join(' · ')}` : 'Positions',
  }),
  View: PositionChart,
});
