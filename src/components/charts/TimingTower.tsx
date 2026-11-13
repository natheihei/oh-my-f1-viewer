/** The running order, one row per driver: position, places gained from the grid, gaps, last lap and tyre. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type StartingGridEntry } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  colors,
  compoundLetter,
  formatGap,
  formatLapTime,
  hline,
  num,
  parseGap,
  stintAge,
  styleOf,
  text,
  textWidth,
  tyreColour,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

// Each driver's latest position, gaps, lap, last completed lap and stint, and whether they're out, with
// those that are out last. `laps` is read once.
export const SQL = `
WITH l AS MATERIALIZED (SELECT driver_number, lap_number, lap_duration, is_out FROM laps),
pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
gap AS (SELECT driver_number, gap_to_leader, interval, MAX(date) AS gap_date FROM intervals GROUP BY driver_number),
lap AS (SELECT driver_number, MAX(lap_number) AS lap FROM l GROUP BY driver_number),
last AS (SELECT driver_number, lap_duration AS last_lap, MAX(lap_number) FROM l WHERE lap_duration IS NOT NULL GROUP BY driver_number),
tyre AS (SELECT driver_number, compound, lap_start, lap_end, tyre_age_at_start, MAX(stint_number) FROM stints GROUP BY driver_number),
out AS (SELECT DISTINCT driver_number FROM l WHERE is_out)
SELECT pos.driver_number, pos.position, gap.gap_to_leader, gap.interval, gap.gap_date, lap.lap, last.last_lap,
  tyre.compound, tyre.lap_start, tyre.lap_end, tyre.tyre_age_at_start, out.driver_number IS NOT NULL AS is_out
FROM pos
LEFT JOIN gap USING (driver_number) LEFT JOIN lap USING (driver_number) LEFT JOIN last USING (driver_number) LEFT JOIN tyre USING (driver_number)
LEFT JOIN out USING (driver_number)
ORDER BY is_out, pos.position`;

export interface TowerRow {
  driver: number;
  position: number | null;
  /** Places gained since the grid: negative is lost. Null without a grid slot, or once retired. */
  gained: number | null;
  /** "+1.234", "+1 LAP", or "LAP 31" for the leader, "LAP 31/56" when the distance is known. "OUT" once retired. */
  gap: string;
  interval: string;
  last: string;
  compound: string | null;
  age: number | null;
  /** Retired: drawn dimmed, with no interval or last lap. */
  out: boolean;
}

/**
 * The rows of `SQL` as text, ready to draw. Lapped cars read "+1 LAP", never NaN, and retired ones "OUT".
 * `total` is the race distance, and `grid` the starting order, which only a race or sprint has.
 */
export function towerModel(
  rows: ReadonlyArray<Record<string, unknown>>,
  total: number | null = null,
  grid: readonly StartingGridEntry[] = [],
): TowerRow[] {
  const slots = new Map(grid.map((g) => [g.driver_number, g.position]));
  return rows.flatMap((r, i): TowerRow[] => {
    const driver = num(r.driver_number);
    if (driver === null) return [];
    const lap = num(r.lap);
    const start = num(r.lap_start);
    const out = Boolean(r.is_out);
    const position = num(r.position);
    const slot = slots.get(driver) ?? null;
    // The leader's gap is the lap it's on, once the session has gaps at all.
    const leader = i === 0 && !out;
    return [
      {
        driver,
        position,
        gained: out || slot === null || position === null ? null : slot - position,
        gap: out ? 'OUT' : leader ? (r.gap_date != null && lap !== null ? `LAP ${lap}${total ? `/${total}` : ''}` : '') : formatGap(parseGap(r.gap_to_leader)),
        interval: out || leader ? '' : formatGap(parseGap(r.interval)),
        last: out ? '' : formatLapTime(num(r.last_lap)),
        compound: typeof r.compound === 'string' ? r.compound : null,
        age: start === null ? null : stintAge(start, num(r.lap_end), num(r.tyre_age_at_start)),
        out,
      },
    ];
  });
}

type Key = 'position' | 'bar' | 'code' | 'gain' | 'gap' | 'interval' | 'last' | 'tyre';

/** Width in characters, and which go first when there's no room: higher drops sooner. */
const COLUMNS: Array<{ key: Key; head: string; chars: number; drop: number }> = [
  { key: 'position', head: 'P', chars: 2, drop: 0 },
  { key: 'bar', head: '', chars: 0.5, drop: 0 },
  { key: 'code', head: '', chars: 3, drop: 0 },
  { key: 'gain', head: '+/−', chars: 3, drop: 5 },
  { key: 'gap', head: 'GAP', chars: 9, drop: 1 },
  { key: 'interval', head: 'INT', chars: 7, drop: 3 },
  { key: 'last', head: 'LAST', chars: 8, drop: 4 },
  { key: 'tyre', head: 'TYRE', chars: 4, drop: 2 },
];

/** The most size, spacing, padding and row pitch `draw` ever uses, so how large the tower draws at most. */
const MAX_SIZE = 12;
const MAX_SPACING = 3;
const PAD = 8;
const HEAD = 16;
const MAX_PITCH = 22;
/** A full grid. A session with fewer cars leaves a little room at the bottom, rather than resizing as cars retire. */
const MAX_CARS = 22;
const TALLEST = HEAD + MAX_CARS * MAX_PITCH;
/** JetBrains Mono's advance is 0.6 of its size. */
const WIDEST = Math.ceil(
  COLUMNS.reduce((sum, col, i) => sum + col.chars + (i === 0 ? 0 : col.key === 'bar' || col.key === 'code' ? 0.6 : MAX_SPACING), 0) * MAX_SIZE * 0.6 + PAD * 2,
);

interface Drawn {
  rows: TowerRow[];
  /** Whether there's a grid to count places from: without one the column isn't drawn. */
  gains: boolean;
  styles: Map<number, DriverStyle>;
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const pad = compact ? 4 : PAD;
  const head = compact ? 0 : HEAD;
  const pitch = Math.min(MAX_PITCH, Math.max(compact ? 9 : 12, (height - head - pad) / Math.max(1, m.rows.length)));
  const size = Math.min(MAX_SIZE, Math.max(8, Math.floor(pitch * 0.58)));
  const ch = textWidth(ctx, '0', size);

  // Drop columns until the rest fit, with at least a character and a half between them.
  let columns = COLUMNS.filter((col) => (!compact || col.drop < 3) && (m.gains || col.key !== 'gain'));
  const room = width - pad * 2;
  const needed = (cols: typeof columns) => cols.reduce((sum, col) => sum + col.chars, 0) * ch + (cols.length - 1) * 1.5 * ch;
  while (needed(columns) > room && columns.some((col) => col.drop > 0)) {
    const worst = Math.max(...columns.map((col) => col.drop));
    columns = columns.filter((col) => col.drop !== worst);
  }
  const spacing = Math.min(MAX_SPACING * ch, Math.max(1.5 * ch, (room - columns.reduce((s, col) => s + col.chars, 0) * ch) / (columns.length - 1)));
  const edges = new Map<Key, { x0: number; x1: number }>();
  let at = pad;
  for (const col of columns) {
    // The bar sits tight against the code.
    const gap = col.key === 'code' || col.key === 'bar' ? ch * 0.6 : spacing;
    if (at > pad) at += gap;
    edges.set(col.key, { x0: at, x1: at + col.chars * ch });
    at += col.chars * ch;
  }

  if (head) {
    for (const col of columns) {
      const e = edges.get(col.key)!;
      if (col.head) text(ctx, col.head, e.x1, head / 2 + 1, { align: 'right', color: c.faint, size: 9 });
    }
  }

  m.rows.forEach((row, i) => {
    const top = head + i * pitch;
    if (top + pitch > height) return;
    const y = top + pitch / 2 + 0.5;
    if (!compact) hline(ctx, pad, width - pad, top);
    const style = styleOf(m.styles, row.driver);
    // A retired car's row is all dim: no ink, and its team colour faded.
    const ink = row.out ? c.dim : c.ink;
    ctx.globalAlpha = row.out ? 0.5 : 1;
    for (const col of columns) {
      const { x0, x1 } = edges.get(col.key)!;
      switch (col.key) {
        case 'position':
          text(ctx, row.position === null ? '' : String(row.position), x1, y, { align: 'right', size });
          break;
        case 'bar':
          ctx.fillStyle = style.colour;
          ctx.fillRect(x0, top + pitch * 0.22, Math.max(2, x1 - x0), pitch * 0.56);
          break;
        case 'code':
          text(ctx, style.code, x0, y, { color: ink, size, weight: 500 });
          break;
        case 'gain':
          if (row.gained === null) break;
          if (row.gained === 0) text(ctx, '–', x1, y, { align: 'right', color: c.faint, size });
          else text(ctx, `${row.gained > 0 ? '▲' : '▼'}${Math.abs(row.gained)}`, x1, y, { align: 'right', color: row.gained > 0 ? c.ink : c.dim, size });
          break;
        case 'gap':
          text(ctx, row.gap, x1, y, { align: 'right', color: ink, size });
          break;
        case 'interval':
          text(ctx, row.interval, x1, y, { align: 'right', size });
          break;
        case 'last':
          text(ctx, row.last, x1, y, { align: 'right', color: ink, size });
          break;
        case 'tyre':
          if (!row.compound) break;
          text(ctx, compoundLetter(row.compound), x1 - 3 * ch, y, { align: 'right', color: tyreColour(row.compound), size, weight: 500 });
          if (row.age !== null) text(ctx, String(row.age), x1, y, { align: 'right', size });
          break;
      }
    }
    ctx.globalAlpha = 1;
  });
}

const NO_GRID: StartingGridEntry[] = [];

function TimingTower() {
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const total = useLive((live) => (live.sessionData.state === 'ready' ? (live.sessionData.lapCount?.total ?? null) : null));
  const grid = useLive((live) => (live.sessionData.state === 'ready' ? live.sessionData.startingGrid : NO_GRID));
  const model = useMemo(
    () => (view.state === 'ready' ? { rows: towerModel(view.rows, total, grid), gains: grid.some((g) => g.position != null), styles } : null),
    [view, styles, total, grid],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'timing_tower',
  title: 'Timing tower',
  description:
    'The running order: position, places gained or lost since the grid in a race, gap to the leader, interval to the car ahead, last lap, and tyre with its age, with retired cars at the bottom marked OUT. Suggest it for an overview, whenever the user asks where someone is, or who has gained or lost places.',
  args: Type.Object({}),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 0.75, min: { width: 330, height: 376 } },
  fit: { width: WIDEST, height: TALLEST },
  spec: () => ({ key: 'timing_tower', label: 'Timing' }),
  View: TimingTower,
});
