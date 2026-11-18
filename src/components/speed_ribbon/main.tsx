/** One car's last lap traced on the circuit as a ribbon: thicker where it's faster, in the pedal colours, green on throttle, darker on a lift and red on the brake, with each corner's slowest speed. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, Driver, useLive, useSql, useSqlWindow, type CircuitView } from 'omfv';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
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
} from 'omfv/kit';

const NEEDS = ['telemetry' as const];

/** The ribbon is one lap long, in seconds, kept within these: a lap behind the safety car can run past two minutes. */
export const WINDOW = { least: 60, most: 120 };
/** Positions further apart than this, in ms, break the ribbon: the feed sends about four a second. */
const BREAK_MS = 2000;
/** What the feed sends for throttle and brake when it has no reading. */
const NO_READING = 104;

/** The car's latest lap time, which sets how far back the ribbon goes. */
export const LAP_SQL = `SELECT lap_duration FROM laps WHERE driver_number = ?1 AND lap_duration IS NOT NULL ORDER BY lap_number DESC LIMIT 1`;

/**
 * Car `?3`'s positions and samples after `?1` up to `?2`, read by `useSqlWindow` over the window. Each half is
 * bounded both ways by `date`, the second column of the primary key, so it reads an index range of every car's
 * rows and keeps this one's. A row is never revealed before its `date`, so the playhead is the upper bound.
 */
export const SQL = `SELECT date, x, y, NULL AS speed, NULL AS n_gear, NULL AS throttle, NULL AS brake FROM location
WHERE date > ?1 AND date <= ?2 AND driver_number = ?3
UNION ALL SELECT date, NULL, NULL, speed, n_gear, throttle, brake FROM car_data
WHERE date > ?1 AND date <= ?2 AND driver_number = ?3
ORDER BY date`;

/** The window in seconds, from the latest lap time: whole seconds, within `WINDOW`. */
export function windowSeconds(rows: ReadonlyArray<Record<string, unknown>>): number {
  const lap = num(rows[0]?.lap_duration);
  return lap === null ? WINDOW.least : Math.max(WINDOW.least, Math.min(WINDOW.most, Math.round(lap)));
}

/** Throttle at or above this, in per cent, is flat out; under it without the brake is a lift. */
export const FULL_THROTTLE = 95;
/** How much faster, in km/h, the car must be again after a low point for it to count as the corner's minimum. */
const RISE = 10;

export interface RibbonPoint {
  x: number;
  y: number;
  /** From the latest sample at or before the position; null before the first. */
  speed: number | null;
  braking: boolean;
  /** Off full throttle without braking: a lift, a coast or a part-throttle exit. Never while the feed has no reading. */
  lifting: boolean;
}

export interface RibbonModel {
  /** Oldest first; null breaks the ribbon at a gap. */
  path: Array<RibbonPoint | null>;
  /** The latest position. */
  now: RibbonPoint | null;
  speed: number | null;
  gear: number | null;
  /** 0 to 100, null while the feed has no reading. */
  throttle: number | null;
  /** Null while the feed has no reading. */
  braking: boolean | null;
}

interface Sample {
  date: number;
  speed: number | null;
  gear: number | null;
  throttle: number | null;
  braking: boolean;
  unread: boolean;
}

/**
 * The rows of `SQL` as a path. Each position takes the speed and pedals of the latest sample at or before it.
 * The feed's brake is only ever 0, 100 or 104, and a throttle or brake of 104 is no reading: drawn as neither
 * braking nor lifting, and as no value in the readout. A position of exactly (0, 0) is the feed's placeholder
 * for a car with none, so it's left out.
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
    const [throttle, brake] = [num(r.throttle), num(r.brake)];
    const unread = throttle === NO_READING || brake === NO_READING;
    samples.push({
      date,
      speed: num(r.speed),
      gear: num(r.n_gear),
      throttle: unread || throttle === null ? null : Math.max(0, Math.min(100, throttle)),
      braking: !unread && brake !== null && brake > 0,
      unread,
    });
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
    const braking = s?.braking ?? false;
    const lifting = !!s && !braking && s.throttle !== null && s.throttle < FULL_THROTTLE;
    path.push({ x: p.x, y: p.y, speed: s?.speed ?? null, braking, lifting });
    previous = p.date;
  }
  const last = samples.at(-1);
  return {
    path,
    now: path.at(-1) ?? null,
    speed: last?.speed ?? null,
    gear: last?.gear ?? null,
    throttle: last?.throttle ?? null,
    braking: !last || last.unread ? null : last.braking,
  };
}

/**
 * Each braking zone's slowest point: from where the brake comes off, the lowest speed until the car is `RISE`
 * km/h faster again. A zone the car hasn't come out of yet, and one cut by a gap, has none.
 */
export function cornerSpeeds(path: ReadonlyArray<RibbonPoint | null>): RibbonPoint[] {
  const lows: RibbonPoint[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (!p?.braking || path[i - 1]?.braking) continue;
    let j = i;
    while (path[j + 1]?.braking) j++;
    let low = path[j]!;
    let out = false;
    for (let m = j + 1; m < path.length; m++) {
      const q = path[m];
      if (!q || q.speed === null || q.braking) break;
      if (low.speed === null || q.speed < low.speed) low = q;
      else if (q.speed >= low.speed + RISE) {
        out = true;
        break;
      }
    }
    if (out && low.speed !== null) lows.push(low);
    i = j;
  }
  return lows;
}

/** The ribbon's width at a speed, in pixels: thin at hairpin speed, full on the straights. */
export const ribbonWidth = (speed: number | null, compact = false) =>
  (compact ? 0.6 : 1) * (1 + Math.max(0, Math.min(1, ((speed ?? 60) - 60) / 280)) * 5);

/** A `#rrggbb` colour scaled toward black: 1 is the colour, 0 black. */
const toward = (hex: string, k: number) => {
  const v = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((v >> shift) & 255) * k);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
};

interface Drawn extends RibbonModel {
  circuit: Extract<CircuitView, { state: 'ready' }>;
  style: DriverStyle;
}

const BACKGROUND = '#000';
/** The readout's row at the top, in pixels. */
const READOUT = 28;
/** How far past the track's edge a label is tried, in pixels, in turn. */
const LABEL_STEPS = [3, 8, 14];
/** How dark a lift is drawn, as a share of the throttle colour. */
const LIFT = 0.5;

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

  // The outward normal at a point near the line: across the track, away from the circuit's middle.
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [lx, ly] of line) [x0, x1, y0, y1] = [Math.min(x0, lx), Math.max(x1, lx), Math.min(y0, ly), Math.max(y1, ly)];
  const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const normalAt = (px: number, py: number): [number, number] => {
    let k = 0;
    let best = Infinity;
    line.forEach(([lx, ly], i) => {
      const d = (lx - px) ** 2 + (ly - py) ** 2;
      if (d < best) [best, k] = [d, i];
    });
    const [ax, ay] = line[(k + n - 1) % n];
    const [bx, by] = line[(k + 1) % n];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
    if (nx * (px - mx) + ny * (py - my) < 0) [nx, ny] = [-nx, -ny];
    return [nx, ny];
  };

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
  // rather than the team's: an orange or a Ferrari red can't be told from the brake. A lift is a darker green.
  // Braking goes over the rest in a black casing, so a brake zone stays its own mark where red and green are hard
  // to tell apart.
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
  const lift = toward(c.throttle, LIFT);
  for (const [a, b] of pairs) if (!a.braking) segment(a, b, a.lifting ? lift : c.throttle, 0);
  const braking = pairs.filter(([a]) => a.braking);
  for (const [a, b] of braking) segment(a, b, BACKGROUND, compact ? 1.5 : 2.5);
  for (const [a, b] of braking) segment(a, b, c.brake, 0);
  ctx.lineCap = 'butt';

  // The timing line: a bar across the track at the outline's first point, as the track map draws it.
  const [sx, sy] = line[0];
  const [snx, sny] = normalAt(sx, sy);
  const bar = compact ? 5 : 9;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx - snx * bar, sy - sny * bar);
  ctx.lineTo(sx + snx * bar, sy + sny * bar);
  ctx.stroke();

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

  // Speed, gear and the pedals now. The title bar says whose.
  const row = READOUT / 2;
  let x = 10;
  // Numbers get a slot as wide as their widest value, right-aligned, so what follows them doesn't move.
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
  x += textWidth(ctx, '8', 12, 700) + 12;
  // The brake as a chip, lit while braking; faint while the feed has no reading.
  const chipW = textWidth(ctx, 'BRAKE', 9, 700) + 10;
  const chipTop = row + 2 - 7;
  if (m.braking) {
    ctx.fillStyle = c.brake;
    ctx.fillRect(x, chipTop, chipW, 14);
  } else {
    ctx.strokeStyle = m.braking === null ? c.quiet : c.faint;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(chipTop) + 0.5, chipW - 1, 13);
  }
  text(ctx, 'BRAKE', x + chipW / 2, row + 2.5, { align: 'center', size: 9, weight: 700, color: m.braking ? BACKGROUND : c.faint });
  x += chipW + 10;
  text(ctx, 'THR', x, row + 3, { size: 10 });
  x += textWidth(ctx, 'THR') + 6;
  const throttle = m.throttle === null ? '—' : `${Math.round(m.throttle)}%`;
  const thrSlot = textWidth(ctx, '100%', 12, 700);
  text(ctx, throttle, x + thrSlot, row + 2, { align: 'right', color: c.ink, size: 12, weight: 700 });
  x += thrSlot;
  const taken: Rect[] = [{ x: x / 2, y: row, w: x + 8, h: READOUT }];

  // The key, at the right of the readout's row when there's room for it.
  const keyWide = textWidth(ctx, 'wider = faster', 9) + 14 + textWidth(ctx, 'braking', 9);
  if (width - 10 - keyWide > x + 16) {
    taken.push({ x: width - 10 - keyWide / 2, y: row + 3, w: keyWide + 8, h: 12 });
    text(ctx, 'braking', width - 10, row + 3, { align: 'right', color: c.brake, size: 9 });
    text(ctx, 'wider = faster', width - 10 - textWidth(ctx, 'braking', 9) - 14, row + 3, { align: 'right', color: c.mute, size: 9 });
  }
  taken.push({ x: sx, y: sy, w: bar * 2, h: bar * 2 });

  // A label just outside the track, stepped out until it's clear of the track, the tile's edge and what's placed.
  const place = (px: number, py: number, w: number, h: number): Rect | undefined => {
    const [nx, ny] = normalAt(px, py);
    const box = LABEL_STEPS.map((step) => {
      const reach = track / 2 + step + (Math.abs(nx) * w) / 2 + (Math.abs(ny) * h) / 2;
      return { x: px + nx * reach, y: py + ny * reach, w, h };
    }).find(
      (b) =>
        b.x - b.w / 2 >= 0 &&
        b.x + b.w / 2 <= width &&
        b.y - b.h / 2 >= 0 &&
        b.y + b.h / 2 <= height &&
        !taken.some((t) => overlaps(t, b)) &&
        !line.some(([lx, ly]) => Math.abs(lx - b.x) * 2 < b.w + track && Math.abs(ly - b.y) * 2 < b.h + track),
    );
    if (box) taken.push(box);
    return box;
  };

  // Corner speeds first, in ink, so turn numbers give way to them.
  for (const low of cornerSpeeds(m.path)) {
    const [px, py] = fit(low.x, low.y);
    const label = String(Math.round(low.speed!));
    const box = place(px, py, textWidth(ctx, label, 10, 700) + 2, 11);
    if (box) text(ctx, label, box.x, box.y, { align: 'center', color: c.ink, size: 10, weight: 700 });
  }
  for (const corner of corners) {
    const [cx, cy] = fit(corner.x, corner.y);
    const label = String(corner.number);
    const box = place(cx, cy, textWidth(ctx, label, 9) + 2, 10);
    if (box) text(ctx, label, box.x, box.y, { align: 'center', color: c.mute, size: 9 });
  }
}

const NO_PLAYHEAD = 0;
/** Least room: the readout's row over a circuit wide enough for its turn numbers to sit apart. Fit: where a circuit stops gaining detail. */
const MIN = { width: 300, height: 220 };
const FIT = { width: 560, height: 400 };

function SpeedRibbon({ props }: { props: { driver: number } }) {
  const { driver } = props;
  const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null));
  const lapView = useSql(LAP_SQL, [driver]);
  const seconds = windowSeconds(lapView.state === 'ready' ? lapView.rows : []);
  const to = playhead ?? NO_PLAYHEAD;
  const view = useSqlWindow(SQL, [driver], { from: to - seconds * 1000, to });
  const styles = useDriverStyles();
  const circuit = useLive((s) => s.circuit);
  const model = useMemo(() => {
    if (view.state !== 'ready' || circuit.state !== 'ready') return null;
    return { ...ribbonModel(view.rows), circuit, style: styleOf(styles, driver) };
  }, [view, circuit, styles, driver]);
  return (
    <ChartFrame needs={NEEDS} waits={[circuitMessage(circuit)]} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'speed_ribbon',
  title: 'Speed ribbon',
  description:
    "Where on the track one driver is fast and where they brake: their last lap traced on the circuit, wider where faster, green on throttle and red on the brake, with their speed and gear now. Suggest it when the user asks how a driver takes the circuit. For where every car is, use track_map; for one car's pedals and revs over time, car_telemetry; for whether every lap is driven the same, pedal_barcode.",
  replayOnly: true,
  args: Type.Object({ driver: Driver('The driver') }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: Math.round((FIT.width / FIT.height) * 100) / 100, min: MIN },
  fit: FIT,
  spec: ({ driver }) => ({ key: `speed_ribbon:${driver}`, label: 'Speed ribbon', drivers: [driver] }),
  View: SpeedRibbon,
});
