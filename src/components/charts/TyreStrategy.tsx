/** Every driver's stints as bars in tyre colours, in running order, with the laps still to come. */
import { useMemo } from "react";
import Type from "typebox";
import { Displayed, defineComponent, Highlighted, keyPart, useLive, useSql } from "../../host";
import {
  ChartCanvas,
  ChartFrame,
  colors,
  drawCode,
  linear,
  num,
  stintAge,
  styleOf,
  text,
  textWidth,
  ticks,
  tyreColour,
  useDriverSet,
  useDriverStyles,
  vline,
  type Box,
  type Ctx,
  type DriverStyle,
} from "./kit";

const NEEDS = ["timing" as const];

/** Stints with each driver's latest position and whether they're out, those out last; limited to `count` drivers when it isn't 0. */
export const sqlFor = (count: number) => `
WITH pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
out AS (SELECT DISTINCT driver_number FROM laps WHERE is_out)
SELECT s.driver_number, s.stint_number, s.lap_start, s.lap_end, s.compound, s.tyre_age_at_start, pos.position,
  out.driver_number IS NOT NULL AS is_out
FROM stints s LEFT JOIN pos USING (driver_number) LEFT JOIN out USING (driver_number)
${count ? `WHERE s.driver_number IN (${Array.from({ length: count }, () => "?").join(", ")})` : ""}
ORDER BY is_out, pos.position IS NULL, pos.position, s.driver_number, s.stint_number`;

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

export interface TyreRow {
  driver: number;
  /** The latest running position, or null before the feed has one. */
  position: number | null;
  /** Retired: dimmed, with no laps still to come. */
  out: boolean;
  stints: Stint[];
}

export interface TyreModel {
  rows: TyreRow[];
  /** The furthest lap any stint has reached: where the now line is. */
  lap: number;
}

/** Where the lap axis ends: the race distance, so the bars grow across a fixed axis, or the current lap without one. */
const axisLaps = (model: Drawn): number =>
  Math.max(1, model.lap, model.total ?? 0);

/** The rows of the query as one bar row per driver, in running order with those out last. */
export function tyreModel(
  rows: ReadonlyArray<Record<string, unknown>>,
): TyreModel {
  const byDriver = new Map<number, TyreRow>();
  let lap = 0;
  for (const r of rows) {
    const driver = num(r.driver_number);
    const start = num(r.lap_start);
    if (driver === null || start === null) continue;
    const end = Math.max(num(r.lap_end) ?? start, start);
    lap = Math.max(lap, end);
    const row = byDriver.get(driver) ?? {
      driver,
      position: num(r.position),
      out: Boolean(r.is_out),
      stints: [],
    };
    row.stints.push({
      from: start - 1,
      to: end,
      compound: typeof r.compound === "string" ? r.compound : null,
      age: stintAge(start, end, num(r.tyre_age_at_start)),
      open: false,
    });
    byDriver.set(driver, row);
  }
  // Rows arrive in order, then stint order.
  return {
    rows: [...byDriver.values()].map((row) => ({
      ...row,
      stints: row.stints.map((s, i) =>
        i === row.stints.length - 1 ? { ...s, open: true } : s,
      ),
    })),
    lap,
  };
}

interface Drawn extends TyreModel {
  styles: Map<number, DriverStyle>;
  /** The props' drivers: their rows are lifted. */
  highlighted: ReadonlySet<number>;
  /** The scheduled distance, when the session has one. */
  total: number | null;
}

/** Type for codes, positions and stint lengths: the app's smallest. Axis labels are the kit's. */
const SIZE = 11;
/** JetBrains Mono's advance is 0.6 of its size. */
const CH = SIZE * 0.6;
/** The lap axis, on top so it stays in view when the rows run past the bottom. */
const HEAD = 18;
const PAD = 4;
/** Position, the team bar and the code, as the timing tower has them. */
const POS_X = PAD + 2 * CH;
const BAR_X = POS_X + 4;
const CODE_X = BAR_X + 3 + 4;
const GUTTER = Math.ceil(CODE_X + 3 * CH + 6);
/** Room past the flag for a tyre age drawn beside the now line on the last laps. */
const RIGHT = Math.ceil(4 + 2 * CH + 4);
/** A row's height: it shrinks with the tile down to the least that reads, then stops and the rows run on. */
const MIN_PITCH = 16;
const MAX_PITCH = 22;
/** Pixels a lap: the axis keeps its labels apart down to the least, and a lap gains nothing past the most. */
const MIN_LAP = 4;
const MAX_LAP = 8;
/** A full grid and a long race. Fewer cars leave room at the bottom; a longer race runs a little past the right. */
const MAX_CARS = 22;
const MAX_LAPS = 72;
/** The gap cut at each stop, so a stop onto the same compound shows. */
const CUT = 3;

const heightAt = (rows: number, pitch: number): number =>
  HEAD + rows * pitch + PAD;
const widthAt = (laps: number, perLap: number): number =>
  GUTTER + laps * perLap + RIGHT;

/** The least it draws in full at: a full grid at the smallest row, and a long race at the fewest pixels a lap. */
export const LEAST = {
  width: Math.ceil(widthAt(MAX_LAPS, MIN_LAP)),
  height: heightAt(MAX_CARS, MIN_PITCH),
};
/** The most it ever draws: past it the tile is left empty. */
export const MOST = {
  width: Math.ceil(widthAt(MAX_LAPS, MAX_LAP)),
  height: heightAt(MAX_CARS, MAX_PITCH),
};

const pitchOf = (m: Drawn, height: number): number =>
  Math.min(
    MAX_PITCH,
    Math.max(MIN_PITCH, (height - HEAD - PAD) / Math.max(1, m.rows.length)),
  );

/** The tile itself while the chart fits it, and past its bottom or right edge once rows and laps stop shrinking. */
export function tyreExtent(
  m: Drawn,
  { width, height, compact }: Box,
): { width: number; height: number } {
  if (compact) return { width, height };
  return {
    width: Math.max(width, Math.ceil(widthAt(axisLaps(m), MIN_LAP))),
    height: Math.max(
      height,
      Math.ceil(heightAt(m.rows.length, pitchOf(m, height))),
    ),
  };
}

/** The thumbnail, as in the suggestion strip: bars only, fitting the box. */
function drawCompact(ctx: Ctx, m: Drawn, { width, height }: Box): void {
  const x = linear([0, axisLaps(m)], [4, width - 4]);
  const pitch = Math.min(10, (height - 8) / Math.max(1, m.rows.length));
  const bar = Math.max(1, Math.round(pitch * 0.66));
  m.rows.forEach(({ stints }, i) => {
    const y = 4 + i * pitch + (pitch - bar) / 2;
    stints.forEach((s, k) => {
      const x0 = x(s.from) + (k ? 1 : 0);
      if (x(s.to) > x0) {
        ctx.fillStyle = tyreColour(s.compound);
        ctx.fillRect(x0, y, x(s.to) - x0, bar);
      }
    });
  });
}

function draw(ctx: Ctx, m: Drawn, box: Box): void {
  if (box.compact) return drawCompact(ctx, m, box);
  const c = colors();
  const laps = axisLaps(m);
  const pitch = pitchOf(m, box.height);
  const left = GUTTER;
  // The scale stops growing at the most pixels a lap.
  const right = Math.min(box.width, widthAt(laps, MAX_LAP)) - RIGHT;
  const x = linear([0, laps], [left, right]);
  const top = HEAD;
  const bottom = top + pitch * Math.max(1, m.rows.length);
  const bar = Math.round(pitch - 5);
  const now = m.lap;
  const ended = m.total !== null && now >= m.total;
  const ay = HEAD / 2;

  // The axis: laps run, the laps still to come quieter, the flag at the race distance and the now line named.
  const room = Math.max(1, Math.floor((right - left) / 36));
  const step = [1, 2, 5, 10, 20].find((s) => laps / s <= room) ?? 20;
  const nowLabel = ended ? null : `L${now}`;
  const values = ticks(step, laps, 0, step).filter(
    (v) =>
      m.total === null || v === m.total || Math.abs(x(v) - x(m.total)) > 22,
  );
  for (const v of values)
    vline(ctx, x(v), top, bottom, v > now ? c.quiet : c.line);
  for (const v of values) {
    if (v === m.total) continue;
    if (nowLabel && Math.abs(x(v) - x(now)) < 24) continue;
    text(ctx, String(v), x(v), ay, {
      align: "center",
      color: v > now ? c.faint : c.dim,
    });
  }
  if (m.total !== null) {
    vline(ctx, x(m.total), top, bottom, c.line);
    text(ctx, String(m.total), x(m.total), ay, {
      align: "center",
      color: c.dim,
      weight: ended ? 400 : 600,
    });
  }
  text(ctx, "LAP", left - 6, ay, { align: "right", color: c.faint });

  m.rows.forEach(({ driver, position, out, stints }, i) => {
    const rowTop = top + i * pitch;
    const y = rowTop + (pitch - bar) / 2;
    const mid = y + bar / 2 + 0.5;
    const style = styleOf(m.styles, driver);
    const lifted = !out && m.highlighted.has(driver);
    if (lifted) {
      ctx.fillStyle = c.select;
      ctx.fillRect(0, rowTop, box.width, pitch);
    }
    ctx.globalAlpha = out ? 0.4 : 1;
    if (position !== null)
      text(ctx, String(position), POS_X, mid, {
        align: "right",
        color: c.ink,
        size: SIZE,
      });
    drawCode(ctx, style, BAR_X, mid, { size: SIZE, strong: lifted, barHeight: pitch * 0.56 });
    const last = stints[stints.length - 1];
    // The laps still to come, behind a car that's running.
    if (!out && last && m.total !== null && last.to < m.total) {
      ctx.fillStyle = c.quiet;
      ctx.fillRect(x(last.to), y, x(m.total) - x(last.to), bar);
    }
    stints.forEach((s, k) => {
      const x0 = x(s.from) + (k ? CUT : 0);
      const w = x(s.to) - x0;
      if (w <= 0) return;
      ctx.fillStyle = tyreColour(s.compound);
      ctx.fillRect(x0, y, w, bar);
      // Inside a bar is always the stint's length. The set a running car is on has its age outside, after the now line.
      const current = s.open && !out && !ended;
      if (current) return;
      const label = String(s.to - s.from);
      if (textWidth(ctx, label, SIZE, 500) <= w - 6)
        text(ctx, label, x0 + w - 3, mid, {
          align: "right",
          color: "#000",
          size: SIZE,
          weight: 500,
        });
    });
    if (last && !out && !ended) {
      const colour = tyreColour(last.compound);
      text(ctx, String(last.age), Math.max(x(last.to), x(now)) + 4, mid, {
        color: colour === c.faint ? c.dim : colour,
        size: SIZE,
        weight: 500,
      });
    }
    if (out && last)
      text(ctx, "OUT", x(last.to) + 4, mid, { color: c.dim, size: SIZE });
    ctx.globalAlpha = 1;
  });

  if (nowLabel) {
    vline(ctx, x(now), top, bottom, c.ink);
    const w = textWidth(ctx, nowLabel, 10, 600) + 6;
    ctx.fillStyle = "#000";
    ctx.fillRect(x(now) - w / 2, ay - 7, w, 14);
    text(ctx, nowLabel, x(now), ay, {
      align: "center",
      color: c.ink,
      weight: 600,
    });
  }
}

const NONE: number[] = [];

function TyreStrategy({ props }: { props: { drivers?: number[]; drivers_to_display?: number[] } }) {
  const shown = props.drivers_to_display ?? NONE;
  const view = useSql(sqlFor(shown.length), shown);
  const styles = useDriverStyles();
  const highlighted = useDriverSet(props.drivers);
  const total = useLive((live) =>
    live.sessionData.state === "ready"
      ? (live.sessionData.lapCount?.total ?? null)
      : null,
  );
  const model = useMemo(
    () =>
      view.state === "ready"
        ? { ...tyreModel(view.rows), styles, highlighted, total }
        : null,
    [view, styles, highlighted, total],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() =>
        model && <ChartCanvas model={model} draw={draw} extent={tyreExtent} />
      }
    </ChartFrame>
  );
}

export default defineComponent({
  name: "tyre_strategy",
  title: "Tyre strategy",
  description:
    "Every driver's stints as bars in tyre colours: which compound, for how many laps, and when they stopped. Suggest it for tyre choices or strategy across the field; tyre_deg is for how fast the tyres are wearing.",
  args: Type.Object({ drivers_to_display: Displayed(), drivers: Highlighted() }),
  sessions: ["race", "sprint"],
  needs: NEEDS,
  size: {
    aspect: Math.round((MOST.width / MOST.height) * 100) / 100,
    min: LEAST,
  },
  fit: MOST,
  spec: ({ drivers_to_display, drivers }) => ({
    key: `tyre_strategy:${keyPart(drivers_to_display)}${drivers ? `:${keyPart(drivers)}` : ""}`,
    label: "Tyres",
    drivers: drivers_to_display ?? drivers,
  }),
  View: TyreStrategy,
});
