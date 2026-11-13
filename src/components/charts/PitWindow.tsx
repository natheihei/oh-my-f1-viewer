/**
 * One driver's pit stop played out on the field: one lap of time as a ring, leader at 12 o'clock, every
 * car set back by its gap, and where the driver would come out if they stopped now.
 */
import { useMemo, useState } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type Part } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  colors,
  compoundLetter,
  drawCode,
  drawParts,
  fitText,
  isCleanLap,
  median,
  num,
  parseGap,
  partsWidth,
  styleOf,
  text,
  textWidth,
  tyreAgeNow,
  tyreColour,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
  type Pointer,
} from './kit';

const NEEDS = ['timing' as const];

/** Rejoining more than this behind the car ahead on the road counts as clear air, in seconds: closer, its dirty air costs pace. */
export const CLEAR_AIR = 2;
/** The ring's lap time is the leader's median over this many of their latest clean laps. */
const RING_LAPS = 5;

/** Every driver's laps: what makes one clean, where they are, their tyre, and whether they retired. */
export const SQL = `SELECT driver_number, lap_number, date_start, date_end, lap_duration, position, gap_to_leader, interval, compound, tyre_age,
  is_pit_in_lap, is_pit_out_lap, track_status, is_out FROM lap_summary`;

export interface RingCar {
  driver: number;
  /** Seconds behind the leader in race time: more than a lap for a lapped car. */
  gap: number;
  /** Seconds round the ring from the leader: `gap` modulo the ring's lap time. */
  ring: number;
  position: number | null;
  /** The feed gives this car's gap in laps. */
  lapped: boolean;
}

export interface Neighbour {
  driver: number;
  /** Seconds between the two on the road. */
  by: number;
  /** The leader has lapped this car. */
  lapped: boolean;
  /**
   * Laps between this car and the driver after the stop, past the gap on the road: 0 when they're racing on the
   * same lap, more when this car is laps down on them, less when it's laps up, like the leader coming through.
   */
  laps: number;
}

/** Where a stop with one pit loss would put the driver. */
export interface Rejoin {
  gap: number;
  ring: number;
  /** The position they'd rejoin in, in race order. */
  position: number;
  /** The car just ahead on the road where they'd come out, and how far ahead it would be. */
  behind: Neighbour | null;
  /** The car just behind on the road, and how far back. */
  aheadOf: Neighbour | null;
  clearAir: boolean;
  /** Seconds more they'd need to come out a place higher, or null in the lead. */
  short: number | null;
  /** Seconds they could lose and still come out in `position`, or null with nobody behind. */
  spare: number | null;
}

/** Pit losses under a safety car and a virtual one, which are shorter: the field is slow while the car stops. */
export interface NeutralLoss {
  safetyCar: number | null;
  virtualSafetyCar: number | null;
}

export interface PitWindowModel {
  driver: number;
  /** The leader, at 12 o'clock. */
  leader: number | null;
  /** The ring's length in seconds, or null until there's a lap time to go by. */
  lapTime: number | null;
  /** Running cars with a gap, nearest the leader first. */
  cars: RingCar[];
  me: RingCar | null;
  /** MultiViewer's pit loss for the circuit, in seconds, or null without one. */
  pitLoss: number | null;
  /** The driver's position now. */
  from: number | null;
  out: Rejoin | null;
  /** The same stop under a safety car, and under a virtual one. */
  safetyCar: Rejoin | null;
  virtualSafetyCar: Rejoin | null;
  compound: string | null;
  age: number | null;
}

/** `value` modulo `m`, in [0, m). */
const wrap = (value: number, m: number) => ((value % m) + m) % m;

/**
 * The rows of `SQL` as the ring, with `driver`'s stop played out. Each car's gap is the latest the feed
 * gives. A lapped car's gap is text such as "+1 LAP", so it's the car ahead's gap plus the interval
 * between them, as the timing tower adds up, or failing that measured from lap ends: when it finished
 * its latest lap, after the first car to finish that lap. Either way it's more than a lap, which places
 * it on the ring where it is on the road, and counts it behind in race order. A retired car is left off.
 */
export function pitWindowModel(
  rows: ReadonlyArray<Record<string, unknown>>,
  driver: number,
  pitLoss: number | null,
  neutral: NeutralLoss = { safetyCar: null, virtualSafetyCar: null },
): PitWindowModel {
  const latest = new Map<number, Record<string, unknown>>();
  const ends = new Map<number, Map<number, number>>();
  const firstEnd = new Map<number, number>();
  const clean = new Map<number, Array<{ lap: number; time: number }>>();
  const retired = new Set<number>();
  for (const r of rows) {
    const d = num(r.driver_number);
    const lap = num(r.lap_number);
    if (d === null || lap === null) continue;
    if (r.is_out) retired.add(d);
    const last = latest.get(d);
    if (!last || lap >= (num(last.lap_number) ?? 0)) latest.set(d, r);
    const end = num(r.date_end);
    if (end !== null) {
      if (!ends.has(d)) ends.set(d, new Map());
      ends.get(d)!.set(lap, end);
      firstEnd.set(lap, Math.min(end, firstEnd.get(lap) ?? Infinity));
    }
    if (isCleanLap(r)) {
      if (!clean.has(d)) clean.set(d, []);
      clean.get(d)!.push({ lap, time: num(r.lap_duration)! });
    }
  }

  // The leader's recent clean laps, or the whole field's when the leader has none.
  const leader = [...latest].filter(([, r]) => num(r.position) !== null).sort(([, a], [, b]) => num(a.position)! - num(b.position)!)[0]?.[0];
  const recent = (clean.get(leader ?? -1) ?? []).sort((a, b) => b.lap - a.lap).slice(0, RING_LAPS);
  const lapTime = median((recent.length ? recent : [...clean.values()].flat()).map((l) => l.time));

  const lappedGap = (d: number, r: Record<string, unknown>, ahead: RingCar | null): number | null => {
    const interval = parseGap(r.interval);
    if (ahead && interval && 'seconds' in interval && ahead.position === (num(r.position) ?? 0) - 1) return ahead.gap + interval.seconds;
    const own = ends.get(d);
    const lap = own ? Math.max(...own.keys()) : null;
    const first = lap === null ? undefined : firstEnd.get(lap);
    return lap !== null && first !== undefined ? (own!.get(lap)! - first) / 1000 : null;
  };

  // In running order, so a lapped car's gap can build on the car ahead's.
  const order = [...latest].sort(([a, ra], [b, rb]) => (num(ra.position) ?? Infinity) - (num(rb.position) ?? Infinity) || a - b);
  const cars: RingCar[] = [];
  let ahead: RingCar | null = null;
  for (const [d, r] of order) {
    const position = num(r.position);
    const running = !retired.has(d);
    const parsed = parseGap(r.gap_to_leader);
    const lapped = !!parsed && 'laps' in parsed;
    let gap: number | null = null;
    if (d === leader) gap = 0;
    else if (parsed && 'seconds' in parsed) gap = parsed.seconds;
    else if (lapped) gap = lappedGap(d, r, ahead);
    const car = running && gap !== null && gap >= 0 ? { driver: d, gap, ring: lapTime ? wrap(gap, lapTime) : gap, position, lapped } : null;
    if (car) cars.push(car);
    // A retired car, or one without a gap, breaks the chain.
    ahead = car;
  }
  cars.sort((a, b) => a.gap - b.gap || a.driver - b.driver);

  const me = cars.find((c) => c.driver === driver) ?? null;
  const mine = latest.get(driver);
  const others = cars.filter((c) => c !== me);
  const rejoin = (loss: number | null): Rejoin | null => {
    if (!me || loss === null) return null;
    const gap = me.gap + loss;
    // On the road, round the ring; in race order without a lap time to wrap by.
    const inFront = (c: RingCar) => (lapTime ? wrap(gap - c.gap, lapTime) : gap - c.gap);
    const behindBy = (c: RingCar) => (lapTime ? wrap(c.gap - gap, lapTime) : c.gap - gap);
    const nearest = (cands: RingCar[], dist: (c: RingCar) => number, sign: number): Neighbour | null => {
      const best = cands.filter((c) => dist(c) >= 0).sort((a, b) => dist(a) - dist(b))[0];
      if (!best) return null;
      const by = dist(best);
      // What's left of the gap in race time once the road is taken off is whole laps.
      const laps = lapTime ? Math.round((best.gap - gap - sign * by) / lapTime) : 0;
      return { driver: best.driver, by, lapped: best.lapped, laps };
    };
    const behind = nearest(others, inFront, -1);
    const aheadOf = nearest(
      others.filter((c) => c.driver !== behind?.driver),
      behindBy,
      1,
    );
    const raceAhead = others.filter((c) => c.gap < gap).reduce<RingCar | null>((a, c) => (!a || c.gap > a.gap ? c : a), null);
    const raceBehind = others.filter((c) => c.gap >= gap).reduce<RingCar | null>((a, c) => (!a || c.gap < a.gap ? c : a), null);
    return {
      gap,
      ring: lapTime ? wrap(gap, lapTime) : gap,
      position: 1 + others.filter((c) => c.gap < gap).length,
      behind,
      aheadOf,
      clearAir: !behind || behind.by > CLEAR_AIR,
      short: raceAhead ? gap - raceAhead.gap : null,
      spare: raceBehind ? raceBehind.gap - gap : null,
    };
  };
  return {
    driver,
    leader: leader ?? null,
    lapTime,
    cars,
    me,
    pitLoss,
    from: me ? (me.position ?? 1 + others.filter((c) => c.gap < me.gap).length) : null,
    out: rejoin(pitLoss),
    safetyCar: rejoin(neutral.safetyCar),
    virtualSafetyCar: rejoin(neutral.virtualSafetyCar),
    compound: mine && typeof mine.compound === 'string' ? mine.compound : null,
    age: mine ? tyreAgeNow(mine) : null,
  };
}

interface Drawn extends PitWindowModel {
  styles: Map<number, DriverStyle>;
  /** The pointer over the chart: the car under it is named. */
  pointer: Pointer;
}

/** The app's smallest type, and the size of everything written round the ring and in the panel. */
const TYPE = 11;
/** The answer in the middle. */
const BIG = 24;
const RING_WIDTH = 5;
const DOT = 5;
const MY_DOT = 7;
/** Room outside the ring for its labels, stepped out up to three deep where cars crowd. */
const LABEL_ROOM = 44;
/** Labels closer than this round the ring, in pixels, step outwards so they stay readable. */
const LABEL_GAP = 30;
/** The ring's radius: it grows with the tile between these, and below the least the chart runs past the tile. */
const RING_MIN = 96;
const RING_MAX = 150;
/** The panel's rows: two to a line under the ring, one to a line beside it. */
const PANEL_LINES = 4;
const PANEL_PITCH = 28;
const PANEL_BELOW = PANEL_LINES * PANEL_PITCH + 8;
const PANEL_SIDE = 190;
/** Margin either side of the ring's labels, under the ring, so the panel's two columns fit. */
const SIDE_PAD = 14;
/** A tile under this height is a thumbnail, as in the suggestion strip: the ring alone, fitted to it. */
const THUMBNAIL_BELOW = 150;
/** How near the pointer has to be to a dot, in pixels, to name it. */
const HIT = 12;
const BACKGROUND = '#000';

const ringBox = (radius: number) => 2 * (radius + LABEL_ROOM);
/** The least it draws in full at: with the panel under the ring, and beside it. */
export const LEAST = { width: ringBox(RING_MIN) + 2 * SIDE_PAD, height: ringBox(RING_MIN) + PANEL_BELOW };
const LEAST_WIDE = { width: ringBox(RING_MIN) + PANEL_SIDE, height: ringBox(RING_MIN) };
/** Past these the ring stops growing: the panel under it in a tall tile, beside it in a wide one. */
const MOST = { width: ringBox(RING_MAX) + 2 * SIDE_PAD, height: ringBox(RING_MAX) + PANEL_BELOW };
const MOST_WIDE = { width: ringBox(RING_MAX) + PANEL_SIDE, height: ringBox(RING_MAX) };

const thumbnail = (height: number): boolean => height < THUMBNAIL_BELOW;
/** The panel goes beside the ring in a tile wide enough for both, and under it otherwise. */
const wideIn = (width: number, height: number): boolean => width >= height * 1.15 && width >= LEAST_WIDE.width;

/** The tile itself while the ring and panel fit it, and past its bottom or right edge once the ring stops shrinking. */
export function pitWindowExtent(_m: Drawn, { width, height }: Box): { width: number; height: number } {
  if (thumbnail(height)) return { width, height };
  const least = wideIn(width, height) ? LEAST_WIDE : LEAST;
  return { width: Math.max(width, least.width), height: Math.max(height, least.height) };
}

interface PanelRow {
  key: string;
  value: string;
  /** A car the value is about, drawn as its code before the value. */
  driver?: number;
  tyre?: string | null;
}

/** The panel, in pairs that read across: pit loss and tyre, the cars either side, then the margins. */
function panelRows(m: Drawn): PanelRow[] {
  const out = m.out;
  const neighbour = (key: string, n: Neighbour | null, ahead: boolean): PanelRow => {
    if (!n) return { key, value: '—' };
    const tag = n.laps > 0 ? ' · lapped' : n.laps < 0 ? (ahead ? ' · a lap up' : ' · lapping') : '';
    return { key, driver: n.driver, value: ` ${n.by.toFixed(1)} s${tag}` };
  };
  const rows: PanelRow[] = [
    { key: 'PIT LOSS', value: m.pitLoss === null ? '—' : `${m.pitLoss.toFixed(1)} s` },
    { key: 'TYRE', value: m.age !== null ? `${m.age} laps` : '', tyre: m.compound },
    neighbour('CAR AHEAD', out?.behind ?? null, true),
    neighbour('CAR BEHIND', out?.aheadOf ?? null, false),
    { key: out && out.position > 1 ? `TO GAIN P${out.position - 1}` : 'TO GAIN', value: out?.short != null ? `${out.short.toFixed(1)} s short` : '—' },
    { key: out ? `TO KEEP P${out.position}` : 'TO KEEP', value: out?.spare != null ? `${out.spare.toFixed(1)} s spare` : '—' },
  ];
  if (m.safetyCar || m.virtualSafetyCar) {
    const p = (r: Rejoin | null) => (r ? `P${r.position}` : '—');
    rows.push({ key: 'UNDER SC · VSC', value: `${p(m.safetyCar)} · ${p(m.virtualSafetyCar)}` });
  }
  return rows;
}

function draw(ctx: Ctx, m: Drawn, { width, height }: Box): void {
  const c = colors();
  const small = thumbnail(height);
  const me = styleOf(m.styles, m.driver);
  const side = small ? 0 : wideIn(width, height) ? PANEL_SIDE : 0;
  const below = small || side ? 0 : PANEL_BELOW;
  const areaW = width - side;
  // The ring is square, with the panel right under it rather than at the foot of a tall tile.
  const areaH = small || side ? height : Math.min(areaW, height - below);
  const r = small ? Math.max(8, Math.min(areaW, areaH) / 2 - 6) : Math.min(RING_MAX, Math.max(RING_MIN, Math.min(areaW, areaH) / 2 - LABEL_ROOM));
  const cx = areaW / 2;
  const cy = small || side ? areaH / 2 : Math.min(areaH, ringBox(r)) / 2;
  const panelTop = side ? 0 : cy * 2;

  const centre = (line: string | Part[]) =>
    drawParts(ctx, typeof line === 'string' ? [line] : line, m.styles, cx, cy, { align: 'center', color: c.dim, size: small ? 8 : TYPE });
  if (m.lapTime === null) {
    if (!small) centre('Waiting for lap times');
    return;
  }
  const T = m.lapTime;
  const angle = (ring: number) => -Math.PI / 2 - (ring / T) * Math.PI * 2;
  const at = (ring: number, radius = r): [number, number] => [cx + radius * Math.cos(angle(ring)), cy + radius * Math.sin(angle(ring))];
  /** Pixels round the ring between two places on it. */
  const apart = (a: number, b: number) => (Math.abs(wrap(a - b + T / 2, T) - T / 2) / T) * Math.PI * 2 * r;

  ctx.strokeStyle = c.faint;
  ctx.lineWidth = small ? 2 : RING_WIDTH;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // The pit loss, from the driver back round the ring.
  if (m.me && m.out && m.pitLoss !== null) {
    const a0 = angle(m.me.ring);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = small ? 2 : RING_WIDTH;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 - (Math.min(m.pitLoss, T * 0.999) / T) * Math.PI * 2, true);
    ctx.stroke();
  }

  // Under a safety car or a virtual one, the stop costs less: a tick across the ring for each.
  const neutral = [m.safetyCar, m.virtualSafetyCar];
  if (!small && m.safetyCar && m.virtualSafetyCar) {
    for (const o of neutral) {
      const [x0, y0] = at(o!.ring, r - 7);
      const [x1, y1] = at(o!.ring, r + 7);
      ctx.strokeStyle = c.dim;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    // One label for both when they're close; none where it would sit on the answer or on OUT.
    const sc = m.safetyCar.ring;
    const vsc = m.virtualSafetyCar.ring;
    const marks: Array<[number, string]> = apart(sc, vsc) < 34 ? [[(sc + vsc) / 2, 'SC VSC']] : [[sc, 'SC'], [vsc, 'VSC']];
    for (const [ring, label] of marks) {
      const [lx, ly] = at(ring, r - 30);
      const onAnswer = Math.abs(lx - cx) < 80 && Math.abs(ly - cy) < BIG * 1.8;
      const onOut = m.out && apart(ring, m.out.ring) < 30;
      if (!onAnswer && !onOut) text(ctx, label, lx, ly, { align: 'center', color: c.dim, size: TYPE });
    }
  }

  // Only the cars that matter get a code: the driver, the leader, and whoever is around where they'd come out.
  // The rest are dots, named when the pointer is on one.
  const named = new Set<number>([m.driver]);
  if (m.leader !== null) named.add(m.leader);
  if (m.out) {
    for (const n of [m.out.behind, m.out.aheadOf]) if (n) named.add(n.driver);
    for (const car of m.cars) if (wrap(m.out.gap - car.gap, T) <= CLEAR_AIR) named.add(car.driver);
  }
  const dots: Array<{ car: RingCar; x: number; y: number }> = [];
  let previous = -Infinity;
  let level = 0;
  for (const car of [...m.cars].sort((a, b) => a.ring - b.ring)) {
    const style = styleOf(m.styles, car.driver);
    const mine = car.driver === m.driver;
    const [x, y] = at(car.ring);
    dots.push({ car, x, y });
    if (!mine) dotOn(ctx, x, y, small ? 2.5 : DOT, style.colour);
    if (small || !named.has(car.driver)) continue;
    level = ((car.ring - previous) / T) * Math.PI * 2 * r < LABEL_GAP ? (level + 1) % 3 : 0;
    previous = car.ring;
    const a = angle(car.ring);
    const [lx, ly] = at(car.ring, r + 15 + Math.abs(Math.cos(a)) * TYPE + level * (TYPE + 2));
    // The dot is the team mark, so the code is plain: in ink, and bold for the driver.
    drawCode(ctx, style, lx, ly, { variant: 'plain', align: 'center', size: TYPE, strong: mine });
  }
  if (m.me) {
    const [x, y] = at(m.me.ring);
    dotOn(ctx, x, y, small ? 3.5 : MY_DOT, me.colour);
  }

  // Where they'd come out: a hollow marker.
  if (m.out) {
    const [x, y] = at(m.out.ring);
    ctx.fillStyle = BACKGROUND;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.arc(x, y, small ? 3.5 : MY_DOT, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    if (!small) {
      const [ox, oy] = at(m.out.ring, r - 21);
      text(ctx, 'OUT', ox, oy, { align: 'center', color: c.ink, size: TYPE, weight: 700 });
    }
  }
  if (small) return;

  // The answer, in the middle.
  if (!m.me) centre(['No gap for ', { driver: m.driver }, ' yet']);
  else if (m.pitLoss === null) centre('No pit loss for this circuit');
  else if (m.out) {
    drawParts(ctx, ['if ', { driver: m.driver }, ' pits now'], m.styles, cx, cy - BIG * 0.95, { align: 'center', size: TYPE });
    text(ctx, `P${m.out.position}`, cx, cy, { align: 'center', color: c.ink, size: BIG, weight: 700 });
    const air = m.out.clearAir ? 'clear air' : 'traffic';
    text(ctx, m.from !== null ? `from P${m.from} · ${air}` : air, cx, cy + BIG * 0.9, { align: 'center', size: TYPE });
  }

  // The panel: what the ring shows, in numbers.
  const rows = panelRows(m);
  const pad = 8;
  const columns = side ? 1 : 2;
  const colW = side ? side - pad : (width - pad * 2) / 2;
  const pitch = side ? Math.min(34, (height - 24) / rows.length) : PANEL_PITCH;
  rows.forEach((row, i) => {
    const x = side ? areaW + 4 : pad + (i % columns) * colW + (i % columns ? 8 : 0);
    const y = side ? 12 + i * pitch : panelTop + 6 + Math.floor(i / columns) * pitch;
    text(ctx, row.key, x, y, { color: c.mute, size: TYPE });
    let vx = x;
    const vy = y + 14;
    if (row.tyre !== undefined) {
      if (!row.tyre) {
        text(ctx, '—', x, vy, { color: c.ink, size: TYPE });
        return;
      }
      text(ctx, compoundLetter(row.tyre), x, vy, { color: tyreColour(row.tyre), size: TYPE, weight: 700 });
      vx += textWidth(ctx, 'M ', TYPE, 700);
    }
    if (row.driver !== undefined) vx += drawCode(ctx, styleOf(m.styles, row.driver), vx, vy, { size: TYPE });
    text(ctx, fitText(ctx, row.value, colW - (vx - x) - 10, TYPE), vx, vy, { color: c.ink, size: TYPE });
  });
  if (side) text(ctx, "leader at 12 o'clock", areaW + 4, height - 8, { color: c.mute, size: TYPE });

  // The car under the pointer, named.
  const p = m.pointer;
  const hit = p && dots.reduce<{ d: (typeof dots)[number]; dist: number } | null>((best, d) => {
    const dist = Math.hypot(d.x - p.x, d.y - p.y);
    return dist < HIT && (!best || dist < best.dist) ? { d, dist } : best;
  }, null);
  if (hit) {
    const { car, x, y } = hit.d;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, (car.driver === m.driver ? MY_DOT : DOT) + 3, 0, Math.PI * 2);
    ctx.stroke();
    const gap = car.driver === m.leader ? 'leader' : `+${car.gap.toFixed(1)} s${car.lapped ? ' lapped' : ''}`;
    const line: Part[] = [{ driver: car.driver }, ` P${car.position ?? '–'} · ${gap}`];
    const w = partsWidth(ctx, line, m.styles, { size: TYPE }) + 12;
    const bx = Math.min(Math.max(4, x - w / 2), width - w - 4);
    const by = y < 34 ? y + 12 : y - 32;
    ctx.fillStyle = c.select;
    ctx.fillRect(bx, by, w, 20);
    ctx.strokeStyle = c.line;
    ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 19);
    drawParts(ctx, line, m.styles, bx + 6, by + 10.5, { color: c.ink, size: TYPE });
  }
}

function dotOn(ctx: Ctx, x: number, y: number, radius: number, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = BACKGROUND;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 1,
  description: 'The driver whose stop to play out, as a car number',
});

function PitWindow({ props }: { props: { drivers: number[] } }) {
  const [driver] = props.drivers;
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const circuit = useLive((s) => circuitMessage(s.circuit));
  const loss = useLive((s) => (s.circuit.state === 'ready' ? s.circuit.pitLoss : null));
  const [pointer, setPointer] = useState<Pointer>(null);
  const model = useMemo(
    () =>
      view.state === 'ready'
        ? pitWindowModel(view.rows, driver, loss?.normal ?? null, { safetyCar: loss?.safetyCar ?? null, virtualSafetyCar: loss?.virtualSafetyCar ?? null })
        : null,
    [view, driver, loss],
  );
  // The pointer moves often: only the drawing follows it, not the model.
  const drawn = useMemo(() => (model ? { ...model, styles, pointer } : null), [model, styles, pointer]);
  return (
    <ChartFrame needs={NEEDS} waits={[circuit]} views={[view]}>
      {() => drawn && <ChartCanvas model={drawn} draw={draw} extent={pitWindowExtent} onPointer={setPointer} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'pit_window',
  title: 'Pit window',
  description:
    "The field as a ring, with one driver's pit stop played out: where they would rejoin if they stopped now, who they would come out behind and ahead of, and whether that is clear air. Suggest it for one driver's strategy or pit window.",
  args: Type.Object({ drivers: Drivers }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  // Its shape is the one it reads best at, its largest with the panel under the ring.
  size: { aspect: Math.round((MOST.width / MOST.height) * 100) / 100, min: LEAST },
  // A wide tile puts the panel beside the ring, so it can use the wide form's width.
  fit: { width: MOST_WIDE.width, height: MOST.height },
  spec: ({ drivers }) => ({ key: `pit_window:${drivers[0]}`, label: 'Pit window', drivers: [drivers[0]] }),
  View: PitWindow,
});
