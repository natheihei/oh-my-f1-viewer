/** Every driver's stints as bars in tyre colours, in running order. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
  linear,
  num,
  stintAge,
  styleOf,
  text,
  textWidth,
  ticks,
  tyreColour,
  useDriverStyles,
  vline,
  xAxis,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/** Stints with each driver's latest position. `filter` limits it to some drivers. */
export const sqlFor = (count: number) => `
WITH pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number)
SELECT s.driver_number, s.stint_number, s.lap_start, s.lap_end, s.compound, s.tyre_age_at_start, pos.position
FROM stints s LEFT JOIN pos USING (driver_number)
${count ? `WHERE s.driver_number IN (${Array.from({ length: count }, () => '?').join(', ')})` : ''}
ORDER BY pos.position IS NULL, pos.position, s.driver_number, s.stint_number`;

export interface Stint {
  /** The lap before its first, so laps 1 to 16 run from 0 to 16. */
  from: number;
  to: number;
  compound: string | null;
  /** Laps on the set at the stint's end, used ones included. */
  age: number;
  /** The driver's current stint. */
  open: boolean;
}

export interface TyreModel {
  rows: Array<{ driver: number; stints: Stint[] }>;
  /** The furthest lap any stint has reached. */
  lap: number;
}

/** Where the lap axis ends: the race distance, so the bars grow across a fixed axis, or the current lap without one. */
const axisLaps = (model: Drawn): number => Math.max(1, model.lap, model.total ?? 0);

/** The rows of the query as one bar row per driver, in running order. */
export function tyreModel(rows: ReadonlyArray<Record<string, unknown>>): TyreModel {
  const byDriver = new Map<number, Stint[]>();
  let lap = 0;
  for (const r of rows) {
    const driver = num(r.driver_number);
    const start = num(r.lap_start);
    if (driver === null || start === null) continue;
    const end = Math.max(num(r.lap_end) ?? start, start);
    lap = Math.max(lap, end);
    const stints = byDriver.get(driver) ?? [];
    stints.push({ from: start - 1, to: end, compound: typeof r.compound === 'string' ? r.compound : null, age: stintAge(start, end, num(r.tyre_age_at_start)), open: false });
    byDriver.set(driver, stints);
  }
  // Rows arrive in running order, then stint order.
  return {
    rows: [...byDriver].map(([driver, stints]) => ({ driver, stints: stints.map((s, i) => (i === stints.length - 1 ? { ...s, open: true } : s)) })),
    lap,
  };
}

interface Drawn extends TyreModel {
  styles: Map<number, DriverStyle>;
  /** The scheduled distance, when the session has one. */
  total: number | null;
}

/** The tallest a row gets as the tile grows. */
const MAX_PITCH = 24;

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const left = compact ? 4 : 36;
  const right = width - (compact ? 4 : 10);
  const top = compact ? 4 : 6;
  const axis = compact ? 4 : 20;
  const laps = axisLaps(m);
  const x = linear([0, laps], [left, right]);
  const pitch = Math.min(compact ? 10 : MAX_PITCH, (height - top - axis) / Math.max(1, m.rows.length));
  // The axis sits right under the last row, however few there are.
  const bottom = top + pitch * Math.max(1, m.rows.length);
  const bar = Math.max(1, Math.round(pitch * 0.66));
  const size = Math.min(10, Math.max(7, Math.floor(pitch * 0.62)));

  if (!compact) {
    const room = Math.max(1, Math.floor((right - left) / 36));
    const step = [1, 2, 5, 10, 20].find((s) => laps / s <= room) ?? 20;
    const values = ticks(step, laps, 0, step);
    for (const v of values) vline(ctx, x(v), top, bottom);
    xAxis(ctx, { scale: x, values, y: bottom + 12 });
    text(ctx, 'LAP', left, bottom + 12, { color: c.faint, align: 'center' });
  }

  m.rows.forEach(({ driver, stints }, i) => {
    const y = top + i * pitch + (pitch - bar) / 2;
    if (!compact && pitch >= 8) text(ctx, styleOf(m.styles, driver).code, left - 6, y + bar / 2, { align: 'right', color: c.ink, size });
    stints.forEach((s, k) => {
      // A hair between stints, so a stop on the same compound still shows.
      const x0 = x(s.from) + (k ? 1.5 : 0);
      const w = x(s.to) - x0;
      if (w <= 0) return;
      ctx.fillStyle = tyreColour(s.compound);
      ctx.fillRect(x0, y, w, bar);
      if (compact || bar < 8) return;
      // The open stint carries the set's age, a closed one its length.
      const label = String(s.open ? s.age : s.to - s.from);
      if (textWidth(ctx, label, size, 500) <= w - 6) text(ctx, label, x0 + w - 3, y + bar / 2 + 0.5, { align: 'right', color: '#000', size, weight: 500 });
    });
  });
  if (!compact) vline(ctx, x(m.lap), top - 2, bottom, c.ink);
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  description: 'Drivers to show, as car numbers. Left out, it shows everyone.',
});

function TyreStrategy({ props }: { props: { drivers?: number[] } }) {
  const drivers = props.drivers ?? [];
  const view = useSql(sqlFor(drivers.length), drivers);
  const styles = useDriverStyles();
  const total = useLive((live) => (live.sessionData.state === 'ready' ? (live.sessionData.lapCount?.total ?? null) : null));
  const model = useMemo(() => (view.state === 'ready' ? { ...tyreModel(view.rows), styles, total } : null), [view, styles, total]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'tyre_strategy',
  title: 'Tyre strategy',
  description:
    "Every driver's stints as bars in tyre colours: which compound, for how many laps, and when they stopped. Suggest it for anything about tyres or strategy across the field.",
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 16 / 9, min: { width: 380, height: 250 } },
  spec: ({ drivers }) => ({
    key: `tyre_strategy:${drivers?.join('-') ?? 'all'}`,
    label: drivers?.length ? `Tyres ${drivers.map(codeOf).join(' · ')}` : 'Tyres',
  }),
  View: TyreStrategy,
});
