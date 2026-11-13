/**
 * One driver's pit stop played out on the field: one lap of time as a ring, leader at 12 o'clock, every
 * car set back by its gap, and where the driver would come out if they stopped now.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  codeOf,
  colors,
  compoundLetter,
  fitText,
  isCleanLap,
  median,
  num,
  parseGap,
  styleOf,
  text,
  textWidth,
  tyreAgeNow,
  tyreColour,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
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
  lapped: boolean;
}

export interface PitWindowModel {
  driver: number;
  /** The ring's length in seconds, or null until there's a lap time to go by. */
  lapTime: number | null;
  /** Running cars with a gap, nearest the leader first. */
  cars: RingCar[];
  me: RingCar | null;
  /** MultiViewer's pit loss for the circuit, in seconds, or null without one. */
  pitLoss: number | null;
  /** The driver's position now. */
  from: number | null;
  out: {
    gap: number;
    ring: number;
    /** The position they'd rejoin in, in race order. */
    position: number;
    /** The car just ahead on the road where they'd come out, and how far ahead it would be. */
    behind: Neighbour | null;
    /** The car just behind on the road, and how far back. */
    aheadOf: Neighbour | null;
    clearAir: boolean;
  } | null;
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
export function pitWindowModel(rows: ReadonlyArray<Record<string, unknown>>, driver: number, pitLoss: number | null): PitWindowModel {
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
  let out: PitWindowModel['out'] = null;
  if (me && pitLoss !== null) {
    const gap = me.gap + pitLoss;
    // On the road, round the ring; in race order without a lap time to wrap by.
    const inFront = (c: RingCar) => (lapTime ? wrap(gap - c.gap, lapTime) : gap - c.gap);
    const behindBy = (c: RingCar) => (lapTime ? wrap(c.gap - gap, lapTime) : c.gap - gap);
    const nearest = (cands: RingCar[], dist: (c: RingCar) => number): Neighbour | null => {
      const best = cands.filter((c) => dist(c) >= 0).sort((a, b) => dist(a) - dist(b))[0];
      return best ? { driver: best.driver, by: dist(best), lapped: best.lapped } : null;
    };
    const behind = nearest(others, inFront);
    const aheadOf = nearest(
      others.filter((c) => c.driver !== behind?.driver),
      behindBy,
    );
    out = {
      gap,
      ring: lapTime ? wrap(gap, lapTime) : gap,
      position: 1 + others.filter((c) => c.gap < gap).length,
      behind,
      aheadOf,
      clearAir: !behind || behind.by > CLEAR_AIR,
    };
  }
  return {
    driver,
    lapTime,
    cars,
    me,
    pitLoss,
    from: me ? (me.position ?? 1 + others.filter((c) => c.gap < me.gap).length) : null,
    out,
    compound: mine && typeof mine.compound === 'string' ? mine.compound : null,
    age: mine ? tyreAgeNow(mine) : null,
  };
}

interface Drawn extends PitWindowModel {
  styles: Map<number, DriverStyle>;
}

/** Labels closer than this round the ring, in pixels, step outwards so they stay readable. */
const LABEL_GAP = 24;
const BACKGROUND = '#000';

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const pad = compact ? 4 : 8;
  const me = styleOf(m.styles, m.driver);
  // The panel goes beside the ring in a wide tile and under it otherwise.
  const side = compact ? 0 : width >= height * 1.15 ? Math.min(170, width * 0.4) : 0;
  const below = compact || side ? 0 : Math.min(112, height * 0.36);
  const areaW = width - side;
  const areaH = height - below;
  const r = Math.max(8, Math.min(areaW, areaH) / 2 - (compact ? 6 : 40));
  const cx = areaW / 2;
  const cy = areaH / 2;

  const centre = (line: string) => text(ctx, line, cx, cy, { align: 'center', color: c.dim, size: compact ? 8 : 10 });
  if (m.lapTime === null) {
    if (!compact) centre('Waiting for lap times');
    return;
  }
  const T = m.lapTime;
  const angle = (ring: number) => -Math.PI / 2 - (ring / T) * Math.PI * 2;
  const at = (ring: number, radius = r): [number, number] => [cx + radius * Math.cos(angle(ring)), cy + radius * Math.sin(angle(ring))];

  ctx.strokeStyle = c.faint;
  ctx.lineWidth = compact ? 2 : 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // The pit loss, from the driver back round the ring.
  if (m.me && m.out && m.pitLoss !== null) {
    const a0 = angle(m.me.ring);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = compact ? 2 : 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 - (Math.min(m.pitLoss, T * 0.999) / T) * Math.PI * 2, true);
    ctx.stroke();
  }

  // Cars, the driver last so it sits on top, with labels stepped out where they crowd.
  let previous = -Infinity;
  let level = 0;
  for (const car of [...m.cars].sort((a, b) => a.ring - b.ring)) {
    const style = styleOf(m.styles, car.driver);
    const mine = car.driver === m.driver;
    const [x, y] = at(car.ring);
    if (!mine) dotOn(ctx, x, y, compact ? 2.5 : 3.5, style.colour);
    if (compact) continue;
    const apart = ((car.ring - previous) / T) * Math.PI * 2 * r;
    level = apart < LABEL_GAP ? (level + 1) % 3 : 0;
    previous = car.ring;
    const a = angle(car.ring);
    const [lx, ly] = at(car.ring, r + 11 + Math.abs(Math.cos(a)) * 8 + level * 11);
    text(ctx, style.code, lx, ly, { align: 'center', color: mine ? c.ink : style.colour, size: 9, weight: mine ? 700 : 400 });
  }
  if (m.me) {
    const [x, y] = at(m.me.ring);
    dotOn(ctx, x, y, compact ? 3.5 : 5, me.colour);
  }

  // Where they'd come out: a hollow marker.
  if (m.out) {
    const [x, y] = at(m.out.ring);
    ctx.fillStyle = BACKGROUND;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.arc(x, y, compact ? 3.5 : 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    if (!compact) {
      const [ox, oy] = at(m.out.ring, r - 17);
      text(ctx, 'OUT', ox, oy, { align: 'center', color: c.ink, size: 8, weight: 700 });
    }
  }
  if (compact) return;

  // The answer, in the middle.
  const big = r < 70 ? 16 : 24;
  if (!m.me) centre(`No gap for ${me.code} yet`);
  else if (m.pitLoss === null) centre('No pit loss for this circuit');
  else if (m.out) {
    text(ctx, `if ${me.code} pits now`, cx, cy - big * 0.9, { align: 'center', size: 9 });
    text(ctx, `P${m.out.position}`, cx, cy, { align: 'center', color: c.ink, size: big, weight: 700 });
    if (m.from !== null) text(ctx, `from P${m.from}`, cx, cy + big * 0.85, { align: 'center', size: 9 });
  }

  // The panel: what the ring shows, in numbers.
  const rows: Array<{ key: string; value: string; color?: string; tyre?: string | null }> = [
    { key: 'PIT LOSS', value: m.pitLoss === null ? '—' : `${m.pitLoss.toFixed(1)} s` },
    { key: 'REJOINS', value: m.out ? `P${m.out.position}${m.from !== null ? ` from P${m.from}` : ''}` : '—' },
    neighbour('BEHIND', m.out?.behind ?? null, '+', m.styles),
    neighbour('AHEAD OF', m.out?.aheadOf ?? null, '−', m.styles),
    { key: 'CLEAR AIR', value: m.out ? (m.out.clearAir ? 'yes' : 'no, in traffic') : '—' },
    { key: 'TYRE', value: m.age !== null ? `${m.age} laps` : '', tyre: m.compound },
  ];
  const columns = side ? 1 : 2;
  const colW = side ? side - pad : (width - pad * 2) / 2;
  const pitch = side ? Math.min(34, (height - 24) / rows.length) : Math.min(34, (below - 4) / 3);
  rows.forEach((row, i) => {
    const x = side ? areaW + 4 : pad + (i % columns) * colW + (i % columns ? 8 : 0);
    const y = side ? 12 + i * pitch : areaH + 6 + Math.floor(i / columns) * pitch;
    text(ctx, row.key, x, y, { color: c.faint, size: 8 });
    let vx = x;
    if (row.tyre !== undefined) {
      if (!row.tyre) {
        text(ctx, '—', x, y + 13, { color: c.ink, size: 11 });
        return;
      }
      text(ctx, compoundLetter(row.tyre), x, y + 13, { color: tyreColour(row.tyre), size: 11, weight: 700 });
      vx += textWidth(ctx, 'M ', 11, 700);
    }
    text(ctx, fitText(ctx, row.value, colW - (vx - x) - 10, 11), vx, y + 13, { color: row.color ?? c.ink, size: 11 });
  });
  if (side) text(ctx, "leader at 12 o'clock", areaW + 4, height - 8, { color: c.faint, size: 8 });
}

function neighbour(key: string, n: Neighbour | null, sign: string, styles: Map<number, DriverStyle>) {
  if (!n) return { key, value: '—' };
  const style = styleOf(styles, n.driver);
  return { key, value: `${style.code} ${sign}${n.by.toFixed(1)}${n.lapped ? ' lapped' : ''}`, color: style.colour };
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
  const pitLoss = useLive((s) => (s.circuit.state === 'ready' ? s.circuit.pitLoss.normal : null));
  const model = useMemo(
    () => (view.state === 'ready' ? { ...pitWindowModel(view.rows, driver, pitLoss), styles } : null),
    [view, driver, pitLoss, styles],
  );
  return (
    <ChartFrame needs={NEEDS} waits={[circuit]} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
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
  size: { aspect: 1, min: { width: 330, height: 300 } },
  spec: ({ drivers }) => ({ key: `pit_window:${drivers[0]}`, label: `Pit window ${codeOf(drivers[0])}` }),
  View: PitWindow,
});
