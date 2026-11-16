/** The running order, one row per driver: position, places gained from the grid, gaps, last lap and tyre. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, Highlighted, keyPart, useLive, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  colors,
  compoundLetter,
  drawCode,
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
  useDriverSet,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

// Each driver's latest position, gaps, lap, last completed lap and stint, grid slot, and whether they're
// out, with those that are out last. `laps` is read once. Only a race or sprint has a grid.
export const SQL = `
WITH l AS MATERIALIZED (SELECT driver_number, lap_number, lap_duration, is_out FROM laps),
pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
gap AS (SELECT driver_number, gap_to_leader, interval, MAX(date) AS gap_date FROM intervals GROUP BY driver_number),
lap AS (SELECT driver_number, MAX(lap_number) AS lap FROM l GROUP BY driver_number),
last AS (SELECT driver_number, lap_duration AS last_lap, MAX(lap_number) FROM l WHERE lap_duration IS NOT NULL GROUP BY driver_number),
tyre AS (SELECT driver_number, compound, lap_start, lap_end, tyre_age_at_start, MAX(stint_number) FROM stints GROUP BY driver_number),
out AS (SELECT DISTINCT driver_number FROM l WHERE is_out)
SELECT pos.driver_number, pos.position, gap.gap_to_leader, gap.interval, gap.gap_date, lap.lap, last.last_lap,
  tyre.compound, tyre.lap_start, tyre.lap_end, tyre.tyre_age_at_start, out.driver_number IS NOT NULL AS is_out,
  starting_grid.position AS grid_position
FROM pos
LEFT JOIN gap USING (driver_number) LEFT JOIN lap USING (driver_number) LEFT JOIN last USING (driver_number) LEFT JOIN tyre USING (driver_number)
LEFT JOIN out USING (driver_number) LEFT JOIN starting_grid USING (driver_number)
ORDER BY is_out, pos.position`;

export interface TowerRow {
  driver: number;
  position: number | null;
  /** Places gained since the grid: negative is lost. Null without a grid slot, or once retired. */
  gained: number | null;
  /** "+1.234", "+1 LAP", or "LAP 31" for the leader, "LAP 31/56" when the distance is known. "OUT" once retired. */
  gap: string;
  interval: string;
  /** The interval in seconds, or null for the leader, a lapped interval or none. */
  intervalSeconds: number | null;
  last: string;
  compound: string | null;
  age: number | null;
  /** Retired: drawn dimmed, with no interval or last lap. */
  out: boolean;
}

/**
 * The rows of `SQL` as text, ready to draw. Lapped cars read "+1 LAP", never NaN, and retired ones "OUT".
 * `total` is the race distance.
 */
export function towerModel(rows: ReadonlyArray<Record<string, unknown>>, total: number | null = null): TowerRow[] {
  return rows.flatMap((r, i): TowerRow[] => {
    const driver = num(r.driver_number);
    if (driver === null) return [];
    const lap = num(r.lap);
    const start = num(r.lap_start);
    const out = Boolean(r.is_out);
    const position = num(r.position);
    const slot = num(r.grid_position);
    // The leader's gap is the lap it's on, once the session has gaps at all.
    const leader = i === 0 && !out;
    const interval = out || leader ? null : parseGap(r.interval);
    return [
      {
        driver,
        position,
        gained: out || slot === null || position === null ? null : slot - position,
        gap: out ? 'OUT' : leader ? (r.gap_date != null && lap !== null ? `LAP ${lap}${total ? `/${total}` : ''}` : '') : formatGap(parseGap(r.gap_to_leader)),
        interval: formatGap(interval),
        intervalSeconds: interval && 'seconds' in interval ? interval.seconds : null,
        last: out ? '' : formatLapTime(num(r.last_lap)),
        compound: typeof r.compound === 'string' ? r.compound : null,
        age: start === null ? null : stintAge(start, num(r.lap_end), num(r.tyre_age_at_start)),
        out,
      },
    ];
  });
}

type Key = 'position' | 'driver' | 'gain' | 'gap' | 'interval' | 'last' | 'tyre';

/**
 * Width in characters. Every column is always drawn: a tile too narrow for them lets the tower run past
 * its right edge, where the host marks the cut. Only the thumbnail, in the suggestion strip, leaves some out.
 */
const COLUMNS: Array<{ key: Key; head: string; chars: number; thumbnail: boolean }> = [
  { key: 'position', head: 'P', chars: 2, thumbnail: true },
  // The team bar and the code, drawn as one by drawCode: 3 for the code, and a little over one for the bar and its gap.
  { key: 'driver', head: '', chars: 4.1, thumbnail: true },
  { key: 'gain', head: '+/−', chars: 3, thumbnail: false },
  { key: 'gap', head: 'GAP', chars: 9, thumbnail: true },
  { key: 'interval', head: 'INT', chars: 7, thumbnail: false },
  { key: 'last', head: 'LAST', chars: 8, thumbnail: false },
  { key: 'tyre', head: 'TYRE', chars: 4, thumbnail: true },
];

/** Text size, between the app's smallest type and the largest the tower draws. */
const MIN_SIZE = 11;
const MAX_SIZE = 12;
/** Space between columns, in characters. */
const MIN_SPACING = 1.5;
const MAX_SPACING = 3;
const PAD = 8;
const HEAD = 16;
/** A row's height: it shrinks with the tile down to the least that reads, then stops and the rows run on. */
const MIN_PITCH = 16;
const MAX_PITCH = 22;
/** A full grid. A session with fewer cars leaves a little room at the bottom, rather than resizing as cars retire. */
const MAX_CARS = 22;
/** Below this height the tower is a thumbnail, as in the suggestion strip: it fits the box, with no heads or rules. */
const THUMBNAIL_BELOW = 150;
/** JetBrains Mono's advance is 0.6 of its size. */
const ADVANCE = 0.6;

/** The width the columns take at a text size and spacing, with the padding either side. */
function widthAt(columns: typeof COLUMNS, size: number, spacing: number): number {
  const chars = columns.reduce((sum, col, i) => sum + col.chars + (i === 0 ? 0 : col.key === 'driver' ? ADVANCE : spacing), 0);
  return chars * size * ADVANCE + PAD * 2;
}

/** The height the rows take at a pitch, with the column heads above and the padding below. */
const heightAt = (rows: number, pitch: number): number => HEAD + rows * pitch + PAD;

/** The least the tower draws in full at, a full grid at the smallest row and type. */
const LEAST = { width: Math.ceil(widthAt(COLUMNS, MIN_SIZE, MIN_SPACING)), height: heightAt(MAX_CARS, MIN_PITCH) };
/** The most it ever draws, at the largest row, type and spacing: past it the tile is left empty. */
const MOST = { width: Math.ceil(widthAt(COLUMNS, MAX_SIZE, MAX_SPACING)), height: heightAt(MAX_CARS, MAX_PITCH) };

interface Drawn {
  rows: TowerRow[];
  /** Whether there's a grid to count places from: without one the column isn't drawn. */
  gains: boolean;
  styles: Map<number, DriverStyle>;
  /** The props' drivers: their rows are lifted. */
  highlighted: ReadonlySet<number>;
  /** The season's DRS or Overtake line, in seconds: an interval under it is set in ink and bold. */
  within: number;
}

const thumbnail = (height: number): boolean => height < THUMBNAIL_BELOW;
const columnsOf = (m: Drawn, small: boolean) => COLUMNS.filter((col) => (!small || col.thumbnail) && (m.gains || col.key !== 'gain'));
const pitchOf = (m: Drawn, height: number): number => Math.min(MAX_PITCH, Math.max(MIN_PITCH, (height - HEAD - PAD) / Math.max(1, m.rows.length)));
/** The text size for a row of `pitch` in a tile `width` wide: larger type only where the columns still fit across. */
function sizeOf(columns: typeof COLUMNS, pitch: number, width: number): number {
  let size = Math.min(MAX_SIZE, Math.floor(pitch * 0.58));
  while (size > MIN_SIZE && widthAt(columns, size, MIN_SPACING) > width) size -= 1;
  return Math.max(MIN_SIZE, size);
}

/** The tile itself while the tower fits it, and past its bottom or right edge once rows and type stop shrinking. */
export function towerExtent(m: Drawn, { width, height }: Box): { width: number; height: number } {
  if (thumbnail(height)) return { width, height };
  const pitch = pitchOf(m, height);
  const columns = columnsOf(m, false);
  return {
    width: Math.max(width, Math.ceil(widthAt(columns, sizeOf(columns, pitch, width), MIN_SPACING))),
    height: Math.max(height, Math.ceil(heightAt(m.rows.length, pitch))),
  };
}

function draw(ctx: Ctx, m: Drawn, { width, height }: Box): void {
  const c = colors();
  const small = thumbnail(height);
  const pad = small ? 4 : PAD;
  const head = small ? 0 : HEAD;
  const pitch = small ? Math.min(MAX_PITCH, Math.max(9, (height - pad) / Math.max(1, m.rows.length))) : pitchOf(m, height);
  const columns = columnsOf(m, small);
  const size = small ? Math.min(MAX_SIZE, Math.max(8, Math.floor(pitch * 0.58))) : sizeOf(columns, pitch, width);
  const ch = textWidth(ctx, '0', size);

  const room = width - pad * 2;
  const chars = columns.reduce((s, col) => s + col.chars, 0);
  const spacing = Math.min(MAX_SPACING * ch, Math.max(MIN_SPACING * ch, (room - chars * ch - ADVANCE * ch) / Math.max(1, columns.length - 2)));
  const edges = new Map<Key, { x0: number; x1: number }>();
  let at = pad;
  for (const col of columns) {
    // The driver sits tight against the position.
    const gap = col.key === 'driver' ? ch * ADVANCE : spacing;
    if (at > pad) at += gap;
    edges.set(col.key, { x0: at, x1: at + col.chars * ch });
    at += col.chars * ch;
  }

  if (head) {
    for (const col of columns) {
      const e = edges.get(col.key)!;
      if (col.head) text(ctx, col.head, e.x1, head / 2 + 1, { align: 'right', color: c.mute, size: 9 });
    }
  }

  m.rows.forEach((row, i) => {
    const top = head + i * pitch;
    if (top + pitch > height) return;
    const y = top + pitch / 2 + 0.5;
    const lifted = !row.out && m.highlighted.has(row.driver);
    if (lifted) {
      ctx.fillStyle = c.select;
      ctx.fillRect(0, top + 1, width, pitch - 1);
    }
    if (!small) hline(ctx, pad, width - pad, top, c.quiet);
    const style = styleOf(m.styles, row.driver);
    // A retired car's row is all dim: no ink, and its team colour faded.
    const ink = row.out ? c.dim : c.ink;
    ctx.globalAlpha = row.out ? 0.5 : 1;
    for (const col of columns) {
      const { x0, x1 } = edges.get(col.key)!;
      switch (col.key) {
        case 'position':
          text(ctx, row.position === null ? '' : String(row.position), x1, y, { align: 'right', color: ink, size });
          break;
        case 'driver':
          drawCode(ctx, style, x0, y, { size, tone: row.out ? 'dim' : 'ink', strong: lifted, barHeight: pitch * 0.56 });
          break;
        case 'gain':
          if (row.gained === null) break;
          if (row.gained === 0) text(ctx, '–', x1, y, { align: 'right', color: c.faint, size });
          else text(ctx, `${row.gained > 0 ? '▲' : '▼'}${Math.abs(row.gained)}`, x1, y, { align: 'right', color: row.gained > 0 ? c.ink : c.dim, size });
          break;
        case 'gap':
          text(ctx, row.gap, x1, y, { align: 'right', color: ink, size });
          break;
        case 'interval': {
          // Within the line, the car can attack the one ahead: set in ink and bold.
          const close = !row.out && row.intervalSeconds !== null && row.intervalSeconds < m.within;
          if (row.interval) text(ctx, row.interval, x1, y, { align: 'right', size, color: close ? c.ink : c.dim, weight: close ? 700 : 400 });
          // The feed hasn't sent one yet: missing, not blank.
          else if (!row.out && i > 0) text(ctx, '–', x1, y, { align: 'right', color: c.faint, size });
          break;
        }
        case 'last':
          text(ctx, row.last, x1, y, { align: 'right', color: ink, size });
          break;
        case 'tyre': {
          // A compound the feed hasn't named yet is left blank, age and all, rather than a "?".
          const letter = compoundLetter(row.compound);
          if (!row.compound || letter === '?') break;
          text(ctx, letter, x1 - 3 * ch, y, { align: 'right', color: tyreColour(row.compound), size, weight: 500 });
          if (row.age !== null) text(ctx, String(row.age), x1, y, { align: 'right', size });
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  });
}

function TimingTower({ props }: { props: { drivers?: number[] } }) {
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const total = useLive((live) => (live.sessionData.state === 'ready' ? (live.sessionData.lapCount?.total ?? null) : null));
  const within = useLive((live) => live.spec.chaseAid.within);
  const highlighted = useDriverSet(props.drivers);
  const model = useMemo(
    () =>
      view.state === 'ready' ? { rows: towerModel(view.rows, total), gains: view.rows.some((r) => r.grid_position != null), styles, highlighted, within } : null,
    [view, styles, total, highlighted, within],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} extent={towerExtent} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'timing_tower',
  title: 'Timing tower',
  description:
    'The running order: position, places gained or lost since the grid in a race, gap to the leader, interval to the car ahead, last lap, and tyre with its age, with retired cars at the bottom marked OUT. Suggest it for an overview, whenever the user asks where someone is, or who has gained or lost places.',
  args: Type.Object({ drivers: Highlighted() }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  // Its shape is the one it reads best at, its largest.
  size: { aspect: Math.round((MOST.width / MOST.height) * 100) / 100, min: LEAST },
  fit: MOST,
  spec: ({ drivers }) => ({ key: drivers ? `timing_tower:${keyPart(drivers)}` : 'timing_tower', label: 'Timing', drivers }),
  View: TimingTower,
});
