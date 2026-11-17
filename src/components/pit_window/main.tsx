/**
 * One driver's pit stop played out on the field: one lap of time as a ring, leader at 12 o'clock, every
 * car set back by its gap, and where the driver would come out if they stopped now.
 */
import { useMemo, useState } from 'react';
import Type from 'typebox';
import { defineComponent, Driver, useLive, useSql, type Part } from 'omfv';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  colors,
  compoundLetter,
  drawCode,
  drawParts,
  fitText,
  CLEAR_AIR,
  num,
  partsWidth,
  styleOf,
  text,
  textWidth,
  pitWindowModel,
  PIT_WINDOW_SQL,
  tyreColour,
  useDriverStyles,
  type Box,
  type Ctx,
  type Neighbour,
  type PitWindowModel,
  type Rejoin,
  type RingCar,
  type DriverStyle,
  type Pointer,
} from 'omfv/kit';

const NEEDS = ['timing' as const];

/** `value` modulo `m`, in [0, m). */
const wrap = (value: number, m: number) => ((value % m) + m) % m;

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

function PitWindow({ props }: { props: { driver: number } }) {
  const { driver } = props;
  const view = useSql(PIT_WINDOW_SQL);
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
  args: Type.Object({ driver: Driver('The driver whose stop to play out') }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  // Its shape is the one it reads best at, its largest with the panel under the ring.
  size: { aspect: Math.round((MOST.width / MOST.height) * 100) / 100, min: LEAST },
  // A wide tile puts the panel beside the ring, so it can use the wide form's width.
  fit: { width: MOST_WIDE.width, height: MOST.height },
  spec: ({ driver }) => ({ key: `pit_window:${driver}`, label: 'Pit window', drivers: [driver] }),
  View: PitWindow,
});
