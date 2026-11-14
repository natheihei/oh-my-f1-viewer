/**
 * How fast each car's tyre is fading: its laps on the set it's on, by tyre age, each shaded against the
 * car's own median on that set, lighter for quicker and darker as it falls off. In race order.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, Displayed, Highlighted, keyPart, useSql, type Part } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  colors,
  compoundLetter,
  displayed,
  drawCode,
  drawParts,
  isCleanLap,
  median,
  num,
  styleOf,
  text,
  textWidth,
  tyreAgeNow,
  tyreColour,
  useDriverSet,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/** Every lap with its stint, tyre age, what makes it clean, the position at its end and whether the car retired on it. */
export const SQL = `SELECT driver_number, lap_number, lap_duration, stint_number, compound, tyre_age, is_pit_in_lap, is_pit_out_lap, track_status, is_out, position FROM lap_summary`;

/** What one lap on the current set is drawn as. */
export type Cell =
  /** Counted: its time against the car's median on the set, in seconds, quicker below zero. */
  | { kind: 'lap'; lap: number; delta: number }
  /** Run under a yellow, a safety car or a red: hatched. */
  | { kind: 'neutral'; lap: number }
  /** Not counted for another reason, a pit lap or the first lap of the race: left empty. */
  | { kind: 'skip'; lap: number };

export interface DegRow {
  driver: number;
  /** The latest position, or null before the feed has one. */
  position: number | null;
  compound: string | null;
  /** Laps on the set now, the lap in progress not counted. */
  age: number | null;
  /** The completed laps on the set, by tyre age: index 0 is age 1. A lap the feed hasn't sent is missing. */
  cells: Array<Cell | undefined>;
}

export interface DegModel {
  /** Running cars, in race order. */
  rows: DegRow[];
  /** Retired cars and the lap each retired on, in the order they went out. */
  out: Array<{ driver: number; lap: number }>;
  /** The oldest set in the field, in laps: the grid has a column for each age up to it. */
  ages: number;
}

/** The rows of `SQL` as each running car's current stint, laid out by tyre age. */
export function degModel(rows: ReadonlyArray<Record<string, unknown>>): DegModel {
  const byDriver = new Map<number, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const driver = num(r.driver_number);
    if (driver === null || num(r.lap_number) === null) continue;
    byDriver.set(driver, [...(byDriver.get(driver) ?? []), r]);
  }
  const running: DegRow[] = [];
  const out: DegModel['out'] = [];
  let ages = 0;
  for (const [driver, laps] of byDriver) {
    laps.sort((a, b) => num(a.lap_number)! - num(b.lap_number)!);
    const retired = laps.find((r) => r.is_out);
    if (retired) {
      out.push({ driver, lap: num(retired.lap_number)! });
      continue;
    }
    const last = laps[laps.length - 1];
    const stint = num(last.stint_number);
    const set = laps.filter((r) => num(r.lap_duration) !== null && stint !== null && num(r.stint_number) === stint);
    const reference = median(set.filter(isCleanLap).map((r) => num(r.lap_duration)!));
    const cells: Array<Cell | undefined> = [];
    for (const r of set) {
      const age = num(r.tyre_age);
      if (age === null || age < 1) continue;
      const lap = num(r.lap_number)!;
      cells[age - 1] = isCleanLap(r)
        ? { kind: 'lap', lap, delta: num(r.lap_duration)! - reference! }
        : !r.is_pit_in_lap && !r.is_pit_out_lap && lap > 1 && r.track_status !== 'AllClear'
          ? { kind: 'neutral', lap }
          : { kind: 'skip', lap };
    }
    ages = Math.max(ages, cells.length);
    running.push({ driver, position: num(last.position), compound: typeof last.compound === 'string' ? last.compound : null, age: tyreAgeNow(last), cells });
  }
  running.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.driver - b.driver);
  out.sort((a, b) => a.lap - b.lap || a.driver - b.driver);
  return { rows: running, out, ages };
}

/** The car's median on the set is the middle grey; a lap half a second quicker is lightest, one a second slower darkest. */
const QUICKEST = -0.5;
const SLOWEST = 1;
const LIGHT = 225;
const DARK = 35;
export function shadeOf(delta: number): string {
  const t = Math.max(0, Math.min(1, (delta - QUICKEST) / (SLOWEST - QUICKEST)));
  const v = Math.round(LIGHT - t * (LIGHT - DARK));
  return `rgb(${v},${v},${v})`;
}

const SIZE = 11;
const PAD = 8;
const HEAD = 18;
/** The line under the grid naming retired cars, and the key. */
const LINE = 16;
const MIN_PITCH = 16;
const MAX_PITCH = 20;
/** A cell never narrows past this, and then the grid runs past the tile; it never widens past the other, so a few laps on fresh tyres stay squares. */
const MIN_CELL = 6;
const MAX_CELL = 26;
const MAX_CARS = 22;
/** Below this high it's the suggestion strip's thumbnail: the cells alone. */
const THUMBNAIL_BELOW = 150;
/** The width of a character at `SIZE`, for sizes worked out before there's a canvas. */
const CH = 6.62;
/** Position, the team's mark, code, compound and age, in characters. */
const LABEL_CHARS = 13;

interface Drawn {
  model: DegModel;
  styles: Map<number, DriverStyle>;
  /** The props' drivers: their rows are lifted. */
  highlighted: ReadonlySet<number>;
}

const labelWidth = (ch: number): number => PAD + LABEL_CHARS * ch;
/** The ages the grid has a column for: at least a stint's worth, so a fresh field doesn't fill the tile. */
const columnsOf = (m: DegModel): number => Math.max(1, m.ages);
const heightAt = (m: DegModel, pitch: number): number => HEAD + m.rows.length * pitch + (m.out.length ? LINE : 0) + LINE + PAD;
const pitchOf = (m: DegModel, height: number): number =>
  Math.min(MAX_PITCH, Math.max(MIN_PITCH, (height - HEAD - PAD - LINE - (m.out.length ? LINE : 0)) / Math.max(1, m.rows.length)));

/** A stint this long draws in full at the least size; a longer one runs past its right edge. */
const LONG_STINT = 40;
/** The least it draws in full at: a full field at the smallest row, and a 40-lap stint at the narrowest cell. */
const LEAST = { width: Math.ceil(PAD + LABEL_CHARS * CH + LONG_STINT * MIN_CELL + PAD), height: HEAD + MAX_CARS * MIN_PITCH + LINE + PAD };
/** Past this the cells and rows stop growing: 20 laps at the widest cell, a full field at the largest row. */
const MOST = { width: Math.ceil(PAD + LABEL_CHARS * CH + 20 * MAX_CELL + PAD), height: HEAD + MAX_CARS * MAX_PITCH + LINE + PAD };

/** The tile while the grid fits it, and past its bottom or right edge once rows and cells stop shrinking. */
export function degExtent(d: Drawn, { width, height }: Box): { width: number; height: number } {
  if (height < THUMBNAIL_BELOW) return { width, height };
  const m = d.model;
  // Half a pixel over is rounding, not a cut.
  const past = (need: number, room: number): number => (need > room + 0.5 ? Math.ceil(need) : room);
  return {
    width: past(labelWidth(CH) + columnsOf(m) * MIN_CELL + PAD, width),
    height: past(heightAt(m, pitchOf(m, height)), height),
  };
}

/** Diagonal lines across a cell: a lap run under a yellow or a safety car. */
function hatch(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let k = -h; k < w; k += 4) {
    ctx.beginPath();
    ctx.moveTo(x + k, y + h);
    ctx.lineTo(x + k + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

function draw(ctx: Ctx, d: Drawn, { width, height }: Box): void {
  const c = colors();
  const m = d.model;
  const n = columnsOf(m);
  if (height < THUMBNAIL_BELOW) {
    // The thumbnail: each row's cells, shrunk to fit.
    const pitch = (height - 8) / Math.max(1, m.rows.length);
    const cw = Math.min(MAX_CELL, (width - 8) / n);
    m.rows.forEach((row, i) =>
      row.cells.forEach((cell, j) => {
        if (cell?.kind !== 'lap') return;
        ctx.fillStyle = shadeOf(cell.delta);
        ctx.fillRect(4 + j * cw, 4 + i * pitch, Math.max(1, cw - 1), Math.max(1, pitch - 1));
      }),
    );
    return;
  }
  const ch = textWidth(ctx, '0', SIZE);
  const left = labelWidth(ch);
  const cw = Math.max(MIN_CELL, Math.min(MAX_CELL, (width - left - PAD) / n));
  const pitch = pitchOf(m, height);

  // Tyre age along the top, spaced so the numbers stay apart.
  text(ctx, 'AGE', PAD, HEAD / 2, { color: c.mute, size: 9 });
  const every = [1, 2, 5, 10, 20].find((s) => s * cw >= 3.4 * ch) ?? 20;
  for (let age = 1; age <= n; age++) {
    if (age === 1 || age % every === 0) text(ctx, String(age), left + (age - 0.5) * cw, HEAD / 2, { align: 'center', color: c.mute, size: 9 });
  }

  m.rows.forEach((row, i) => {
    const top = HEAD + i * pitch;
    const y = top + pitch / 2 + 0.5;
    const style = styleOf(d.styles, row.driver);
    const lifted = d.highlighted.has(row.driver);
    if (lifted) {
      ctx.fillStyle = c.select;
      ctx.fillRect(0, top, width, pitch);
    }
    if (row.position !== null) text(ctx, String(row.position), PAD + 2 * ch, y, { align: 'right', color: c.dim, size: SIZE });
    drawCode(ctx, style, PAD + 3 * ch, y, { size: SIZE, strong: lifted, barHeight: pitch * 0.56 });
    // A compound the feed hasn't named is left blank, age and all.
    const letter = compoundLetter(row.compound);
    if (row.compound && letter !== '?') {
      text(ctx, letter, PAD + 8.4 * ch, y, { color: tyreColour(row.compound), size: SIZE, weight: 500 });
      if (row.age !== null) text(ctx, String(row.age), PAD + 12 * ch, y, { align: 'right', color: c.dim, size: SIZE });
    }
    row.cells.forEach((cell, j) => {
      if (!cell || cell.kind === 'skip') return;
      const x = left + j * cw + 1;
      const w = Math.max(1, cw - 2);
      const h = pitch - 4;
      if (cell.kind === 'neutral') hatch(ctx, x, top + 2, w, h, c.line);
      else {
        ctx.fillStyle = shadeOf(cell.delta);
        ctx.fillRect(x, top + 2, w, h);
      }
    });
  });

  // Under the grid: the retired cars, then the key.
  let y = HEAD + m.rows.length * pitch + LINE / 2 + 2;
  if (m.out.length) {
    const names = m.out.flatMap((o, i): Part[] => [i ? ' · ' : '', { driver: o.driver }, ` L${o.lap}`]);
    drawParts(ctx, ['OUT  ', ...names], d.styles, PAD, y, { color: c.mute, size: SIZE });
    y += LINE;
  }
  const label = 'VS OWN MEDIAN';
  text(ctx, label, PAD, y, { color: c.mute, size: 9 });
  let x = PAD + textWidth(ctx, label, 9) + 8;
  text(ctx, '−0.5', x, y, { color: c.mute, size: 9 });
  x += textWidth(ctx, '−0.5', 9) + 4;
  for (let k = 0; k < 5; k++) {
    ctx.fillStyle = shadeOf(QUICKEST + (k * (SLOWEST - QUICKEST)) / 4);
    ctx.fillRect(x + k * 12, y - 5, 10, 10);
  }
  x += 5 * 12 + 2;
  text(ctx, '+1.0s', x, y, { color: c.mute, size: 9 });
  x += textWidth(ctx, '+1.0s', 9) + 12;
  hatch(ctx, x, y - 5, 10, 10, c.line);
  text(ctx, 'yellow', x + 14, y, { color: c.mute, size: 9 });
}

function TyreDeg({ props }: { props: { drivers?: number[]; drivers_to_display?: number[] } }) {
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const highlighted = useDriverSet(props.drivers);
  const shown = props.drivers_to_display;
  const model = useMemo(() => {
    if (view.state !== 'ready') return null;
    const m = degModel(view.rows);
    const out = shown?.length ? m.out.filter((o) => shown.includes(o.driver)) : m.out;
    return { model: { ...m, rows: displayed(m.rows, shown), out }, styles, highlighted };
  }, [view, styles, highlighted, shown]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} extent={degExtent} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'tyre_deg',
  title: 'Tyre deg',
  description:
    "How fast each car's tyre is fading: every lap on the set it's on, by tyre age, shaded against the car's own median on that set, darker as it falls off. In race order. Suggest it when the user asks about tyre wear, degradation or who is struggling on their tyres; tyre_strategy is for which tyres and when they stopped.",
  args: Type.Object({ drivers_to_display: Displayed(), drivers: Highlighted() }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: Math.round((MOST.width / MOST.height) * 100) / 100, min: LEAST },
  fit: MOST,
  spec: ({ drivers_to_display, drivers }) => ({
    key: drivers_to_display || drivers ? `tyre_deg:${keyPart(drivers_to_display)}:${keyPart(drivers, 'none')}` : 'tyre_deg',
    label: 'Tyre deg',
    drivers: drivers_to_display ?? drivers,
  }),
  View: TyreDeg,
});
