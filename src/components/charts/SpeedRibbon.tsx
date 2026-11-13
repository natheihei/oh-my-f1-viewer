/** One car's last lap traced on the circuit as a ribbon: thicker where it's faster, in the pedal colours, green on throttle and red on the brake. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type CircuitView } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  codeOf,
  colors,
  fitOutline,
  num,
  styleOf,
  text,
  textWidth,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['telemetry' as const];

/** The ribbon is one lap long, in seconds, kept within these: a lap behind the safety car can run past two minutes. */
export const WINDOW = { least: 60, most: 120 };
/** Positions further apart than this, in ms, break the ribbon: the feed sends about four a second. */
const BREAK_MS = 2000;
/** What the feed sends for throttle and brake when it has no reading. */
const NO_READING = 104;

/** The car's latest lap time, which sets how far back the ribbon goes. */
export const LAP_SQL = `SELECT lap_duration FROM laps WHERE driver_number = ?1 AND lap_duration IS NOT NULL ORDER BY lap_number DESC LIMIT 1`;

/** The car leading as of the playhead: who is drawn when no driver is named. */
export const LEADER_SQL = `SELECT driver_number FROM position WHERE position = 1 ORDER BY date DESC LIMIT 1`;

/**
 * The car's positions and samples over the window (`?3`, in ms). Each half is bounded both ways by `date`, the
 * second column of the primary key, so it reads an index range of every car's rows over one lap and keeps this
 * one's 350 or so. A row is never revealed before its `date`, so the playhead (`?2`) is the upper bound.
 */
export const SQL = `SELECT date, x, y, NULL AS speed, NULL AS n_gear, NULL AS brake FROM location
WHERE date > ?2 - ?3 AND date <= ?2 AND driver_number = ?1
UNION ALL SELECT date, NULL, NULL, speed, n_gear, brake FROM car_data
WHERE date > ?2 - ?3 AND date <= ?2 AND driver_number = ?1`;

/** The window in seconds, from the latest lap time: whole seconds, within `WINDOW`. */
export function windowSeconds(rows: ReadonlyArray<Record<string, unknown>>): number {
  const lap = num(rows[0]?.lap_duration);
  return lap === null ? WINDOW.least : Math.max(WINDOW.least, Math.min(WINDOW.most, Math.round(lap)));
}

export interface RibbonPoint {
  x: number;
  y: number;
  /** From the latest sample at or before the position; null before the first. */
  speed: number | null;
  braking: boolean;
}

export interface RibbonModel {
  /** Oldest first; null breaks the ribbon at a gap. */
  path: Array<RibbonPoint | null>;
  /** The latest position. */
  now: RibbonPoint | null;
  speed: number | null;
  gear: number | null;
}

interface Sample {
  date: number;
  speed: number | null;
  gear: number | null;
  braking: boolean;
}

/**
 * The rows of `SQL` as a path. Each position takes the speed and brake of the latest sample at or before it.
 * The feed's brake is only ever 0, 100 or 104, and 104 is no reading, which is drawn as not braking. A
 * position of exactly (0, 0) is the feed's placeholder for a car with none, so it's left out.
 */
export function ribbonModel(rows: ReadonlyArray<Record<string, unknown>>): RibbonModel {
  const samples: Sample[] = [];
  const positions: Array<{ date: number; x: number; y: number }> = [];
  for (const r of rows) {
    const date = num(r.date);
    if (date === null) continue;
    const [x, y] = [num(r.x), num(r.y)];
    if (x !== null && y !== null) {
      if (!(x === 0 && y === 0)) positions.push({ date, x, y });
      continue;
    }
    const brake = num(r.brake);
    samples.push({ date, speed: num(r.speed), gear: num(r.n_gear), braking: brake !== null && brake > 0 && brake !== NO_READING });
  }
  samples.sort((a, b) => a.date - b.date);
  positions.sort((a, b) => a.date - b.date);
  const path: RibbonModel['path'] = [];
  let k = -1;
  let previous: number | null = null;
  for (const p of positions) {
    while (k + 1 < samples.length && samples[k + 1].date <= p.date) k++;
    const s = samples[k];
    if (previous !== null && p.date - previous > BREAK_MS) path.push(null);
    path.push({ x: p.x, y: p.y, speed: s?.speed ?? null, braking: s?.braking ?? false });
    previous = p.date;
  }
  const last = samples.at(-1);
  return { path, now: path.at(-1) ?? null, speed: last?.speed ?? null, gear: last?.gear ?? null };
}

/** The ribbon's width at a speed, in pixels: thin at hairpin speed, full on the straights. */
export const ribbonWidth = (speed: number | null, compact = false) =>
  (compact ? 0.6 : 1) * (1 + Math.max(0, Math.min(1, ((speed ?? 60) - 60) / 280)) * 5);

interface Drawn extends RibbonModel {
  circuit: Extract<CircuitView, { state: 'ready' }>;
  style: DriverStyle;
  /** Whether the driver was picked here, not named: then the title bar doesn't say who it is, so the readout does. */
  picked: boolean;
}

const BACKGROUND = '#000';
/** The readout's row at the top, in pixels. */
const READOUT = 28;
/** How far past the track's edge a turn number is tried, in pixels, in turn. */
const LABEL_STEPS = [3, 8, 14];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Rect, b: Rect) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const { outline, corners, rotation } = m.circuit;
  const pad = compact ? 5 : 16;
  const top = compact ? pad : READOUT + 4;
  const fit = fitOutline(outline, rotation, { left: pad, top, width: width - pad * 2, height: height - top - pad });
  const line = outline.x.map((x, i) => fit(x, outline.y[i]));
  const n = line.length;
  if (n < 2) return;

  // The circuit, faint and wide enough to carry the ribbon.
  const track = compact ? 4 : 8;
  ctx.strokeStyle = c.quiet;
  ctx.lineWidth = track;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  // The last lap, oldest first, so the newest lies on top where the window overlaps itself, in the pedal colours
  // rather than the team's: an orange or a Ferrari red can't be told from the brake. Braking goes over the rest in
  // a black casing, so a brake zone stays its own mark where red and green are hard to tell apart.
  ctx.lineCap = 'round';
  const segment = (a: RibbonPoint, b: RibbonPoint, colour: string, extra: number) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = ribbonWidth(a.speed, compact) + extra;
    const [ax, ay] = fit(a.x, a.y);
    const [bx, by] = fit(b.x, b.y);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };
  const pairs = m.path.flatMap((a, i) => {
    const b = m.path[i + 1];
    return a && b ? [[a, b] as const] : [];
  });
  for (const [a, b] of pairs) if (!a.braking) segment(a, b, c.throttle, 0);
  const braking = pairs.filter(([a]) => a.braking);
  for (const [a, b] of braking) segment(a, b, BACKGROUND, compact ? 1.5 : 2.5);
  for (const [a, b] of braking) segment(a, b, c.brake, 0);
  ctx.lineCap = 'butt';

  // Where the car is now.
  if (m.now) {
    const [x, y] = fit(m.now.x, m.now.y);
    ctx.fillStyle = c.ink;
    ctx.strokeStyle = BACKGROUND;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, compact ? 3 : 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (compact) return;

  // Speed and gear now, and who, when the title bar doesn't say.
  const row = READOUT / 2;
  let x = 10;
  if (m.picked) {
    text(ctx, m.style.code, x, row, { color: m.style.colour, size: 11, weight: 700 });
    x += textWidth(ctx, m.style.code, 11, 700) + 10;
  }
  // The speed gets a three-digit slot, right-aligned, so what follows it doesn't move between 99 and 100.
  const speed = m.speed === null ? '—' : String(Math.round(m.speed));
  const slot = textWidth(ctx, '000', 18, 700);
  text(ctx, speed, x + slot, row, { align: 'right', color: c.ink, size: 18, weight: 700 });
  x += slot + 5;
  text(ctx, 'km/h', x, row + 3, { size: 10 });
  x += textWidth(ctx, 'km/h') + 12;
  text(ctx, 'GEAR', x, row + 3, { size: 10 });
  x += textWidth(ctx, 'GEAR') + 6;
  const gear = m.gear === null ? '—' : m.gear === 0 ? 'N' : String(m.gear);
  text(ctx, gear, x, row + 2, { color: c.ink, size: 12, weight: 700 });
  x += textWidth(ctx, gear, 12, 700);
  const readout: Rect = { x: x / 2, y: row, w: x + 8, h: READOUT };

  // The key, at the right of the readout's row when there's room for it.
  const keyWide = textWidth(ctx, 'wider = faster', 9) + 14 + textWidth(ctx, 'braking', 9);
  const taken: Rect[] = [readout];
  if (width - 10 - keyWide > x + 16) {
    taken.push({ x: width - 10 - keyWide / 2, y: row + 3, w: keyWide + 8, h: 12 });
    text(ctx, 'braking', width - 10, row + 3, { align: 'right', color: c.brake, size: 9 });
    text(ctx, 'wider = faster', width - 10 - textWidth(ctx, 'braking', 9) - 14, row + 3, { align: 'right', color: c.mute, size: 9 });
  }

  // Turn numbers, just outside the track, away from the circuit's middle, where they don't touch the readout or each other.
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [lx, ly] of line) [x0, x1, y0, y1] = [Math.min(x0, lx), Math.max(x1, lx), Math.min(y0, ly), Math.max(y1, ly)];
  const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
  for (const corner of corners) {
    const [cx, cy] = fit(corner.x, corner.y);
    let k = 0;
    let best = Infinity;
    line.forEach(([lx, ly], i) => {
      const d = (lx - cx) ** 2 + (ly - cy) ** 2;
      if (d < best) [best, k] = [d, i];
    });
    const [ax, ay] = line[(k + n - 1) % n];
    const [bx, by] = line[(k + 1) % n];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
    if (nx * (cx - mx) + ny * (cy - my) < 0) [nx, ny] = [-nx, -ny];
    const label = String(corner.number);
    const w = textWidth(ctx, label, 9) + 2;
    // Stepped out until it's clear of the track, the tile's edge and what's placed; left out if it never is.
    const box = LABEL_STEPS.map((step) => {
      const reach = track / 2 + step + (Math.abs(nx) * w) / 2 + (Math.abs(ny) * 10) / 2;
      return { x: cx + nx * reach, y: cy + ny * reach, w, h: 10 };
    }).find(
      (b) =>
        b.x - b.w / 2 >= 0 &&
        b.x + b.w / 2 <= width &&
        b.y - b.h / 2 >= 0 &&
        b.y + b.h / 2 <= height &&
        !taken.some((t) => overlaps(t, b)) &&
        !line.some(([lx, ly]) => Math.abs(lx - b.x) * 2 < b.w + track && Math.abs(ly - b.y) * 2 < b.h + track),
    );
    if (!box) continue;
    taken.push(box);
    text(ctx, label, box.x, box.y, { align: 'center', color: c.mute, size: 9 });
  }
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 1,
  description: 'The driver, as a car number. Left out, the leader.',
});

const NO_PLAYHEAD = 0;
/** A car number no car has, for the queries while no driver is known yet. */
const NO_CAR = -1;
/** Least room: the readout's row over a circuit wide enough for its turn numbers to sit apart. Fit: where a circuit stops gaining detail. */
const MIN = { width: 300, height: 220 };
const FIT = { width: 560, height: 400 };

function SpeedRibbon({ props }: { props: { drivers?: number[] } }) {
  const named = props.drivers?.[0];
  const leaderView = useSql(LEADER_SQL);
  const leader = leaderView.state === 'ready' ? num(leaderView.rows[0]?.driver_number) : null;
  const driver = named ?? leader ?? NO_CAR;
  const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null));
  const lapView = useSql(LAP_SQL, [driver]);
  const seconds = windowSeconds(lapView.state === 'ready' ? lapView.rows : []);
  const view = useSql(SQL, [driver, playhead ?? NO_PLAYHEAD, seconds * 1000]);
  const styles = useDriverStyles();
  const circuit = useLive((s) => s.circuit);
  const model = useMemo(() => {
    if (view.state !== 'ready' || circuit.state !== 'ready' || driver === NO_CAR) return null;
    return { ...ribbonModel(view.rows), circuit, style: styleOf(styles, driver), picked: named === undefined };
  }, [view, circuit, styles, driver, named]);
  const waiting = named === undefined && leaderView.state === 'ready' && leader === null ? 'Waiting for the running order' : null;
  return (
    <ChartFrame needs={NEEDS} waits={[circuitMessage(circuit), waiting]} views={named === undefined ? [leaderView, view] : [view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'speed_ribbon',
  title: 'Speed ribbon',
  description:
    "Where on the track one driver is fast and where they brake: their last lap traced on the circuit, wider where faster, green on throttle and red on the brake, with their speed and gear now. The leader when no driver is named. Suggest it when the user asks how a driver takes the circuit. For where every car is, use track_map; to compare two drivers' laps corner by corner, speed_trace; for one car's pedals and revs over time, car_telemetry; for whether every lap is driven the same, pedal_barcode.",
  replayOnly: true,
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: Math.round((FIT.width / FIT.height) * 100) / 100, min: MIN },
  fit: FIT,
  spec: ({ drivers }) => ({
    key: `speed_ribbon:${drivers?.[0] ?? 'leader'}`,
    label: drivers?.length ? `Speed ribbon ${codeOf(drivers[0])}` : 'Speed ribbon',
  }),
  View: SpeedRibbon,
});
