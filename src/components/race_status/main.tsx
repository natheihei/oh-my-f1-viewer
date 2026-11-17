/**
 * What race control has in force now, and who has what against them: a band while the race is held, the
 * restart order under a red flag, grip and the season's aid, the sectors under yellow, the stewards'
 * cases still worth reading, and the laps deleted for track limits.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, partsText, useLive, useSql } from 'omfv';
import {
  type Box,
  type Case,
  ChartCanvas,
  ChartFrame,
  colors,
  type Ctx,
  drawCode,
  type DriverStyle,
  fitText,
  hline,
  num,
  sentenceCase,
  type Stage,
  stageLabel,
  standing,
  type Standing,
  styleOf,
  text,
  textWidth,
  type Track,
  useDriverStyles,
  withCars,
} from 'omfv/kit';

const NEEDS = ['timing' as const];

export const SQL = `SELECT lap_number, category, flag, scope, sector, driver_number, message FROM race_control ORDER BY date`;

/** A decided case stays this many laps after its decision, then leaves the board. */
export const KEEP_DECIDED = 3;

/** One line under the stewards: a case, or the cases to be heard after the race for one reason. */
export interface CaseLine {
  cars: number[];
  /** The cars given the penalty: the others in the case are drawn dim. */
  penalised: number[];
  reason: string;
  turn: number | null;
  stage: Stage;
  penalty: string | null;
  lap: number | null;
}

export interface BoardModel {
  track: Track;
  since: number | null;
  restart: Standing['restart'];
  sectors: Map<number, 'yellow' | 'double'>;
  /** How many cells the strip has: the circuit's marshal sectors, or the highest sector flagged so far. */
  sectorCount: number;
  grip: Standing['grip'];
  /** "Overtake" or "DRS", and whether it's on, or null until race control has said. */
  aid: { label: string; on: boolean } | null;
  aidLabel: string;
  cases: CaseLine[];
  /** Cars with laps deleted, most first, and whether each has had the black and white flag. */
  deleted: Array<{ car: number; laps: number; blackWhite: boolean }>;
  styles: Map<number, DriverStyle>;
}

/** Owed penalties first, then cases being looked at, then fresh decisions, then those left for after the race. */
const RANK: Record<Stage, number> = { penalty: 0, investigating: 1, noted: 2, 'no action': 3, served: 3, 'after the race': 4 };

/**
 * The board for the rows of `SQL`, oldest first. A case decided with no action, or a penalty served, leaves
 * `KEEP_DECIDED` laps after; a penalty owed and an open case stay. Cases left for after the race for the
 * same reason share a line.
 */
export function boardModel(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: { styles: Map<number, DriverStyle>; marshalSectors: number | null; aidLabel: string },
): BoardModel {
  const s = standing(rows);
  const now = s.lap ?? 0;
  const kept = s.cases.filter((c) => !((c.stage === 'no action' || c.stage === 'served') && c.lap !== null && now - c.lap > KEEP_DECIDED));
  const cases: CaseLine[] = [];
  const later = new Map<string, CaseLine>();
  for (const c of kept) {
    const line: CaseLine = { cars: [...c.cars], penalised: c.penalised, reason: c.reason, turn: c.turn, stage: c.stage, penalty: c.penalty, lap: c.lap };
    if (c.stage !== 'after the race') {
      cases.push(line);
      continue;
    }
    const same = later.get(c.reason);
    if (!same) {
      later.set(c.reason, line);
      cases.push(line);
    } else {
      for (const car of c.cars) if (!same.cars.includes(car)) same.cars.push(car);
      if ((c.lap ?? 0) > (same.lap ?? 0)) same.lap = c.lap;
    }
  }
  cases.sort((a, b) => RANK[a.stage] - RANK[b.stage] || (b.lap ?? 0) - (a.lap ?? 0));
  let highest = 0;
  for (const r of rows) if (r.scope === 'Sector') highest = Math.max(highest, num(r.sector) ?? 0);
  const deleted = [...s.deleted]
    .map(([car, laps]) => ({ car, laps, blackWhite: s.blackWhite.has(car) }))
    .sort((a, b) => b.laps - a.laps || a.car - b.car);
  for (const car of s.blackWhite) if (!s.deleted.has(car)) deleted.push({ car, laps: 0, blackWhite: true });
  return {
    track: s.track,
    since: s.since,
    restart: s.restart,
    sectors: s.sectors,
    sectorCount: Math.max(options.marshalSectors ?? 0, highest, ...s.sectors.keys()),
    grip: s.grip,
    aid: s.aid && { label: s.aid.name === 'DRS' ? 'DRS' : 'Overtake', on: s.aid.on },
    aidLabel: options.aidLabel,
    cases,
    deleted,
    styles: options.styles,
  };
}

// Type never goes below the app's smallest, 11px. A row is 19px; the band 28.
const SIZE = 11;
const PAD = 10;
const ROW = 19;
const BAND = 28;
const HEAD = 18;
const CAR = 38;
const STRIP = 36;
/** Under this high, as in the suggestion strip, only the band, the conditions and the strip are drawn, to fit. */
const THUMB_BELOW = 150;

const BAND_LABEL: Record<Exclude<Track, 'green'>, [string, string]> = {
  red: ['RED FLAG', 'RED FLAG'],
  sc: ['SAFETY CAR', 'SC'],
  vsc: ['VIRTUAL SAFETY CAR', 'VSC'],
  scEnd: ['SAFETY CAR IN THIS LAP', 'SC IN'],
  vscEnd: ['VSC ENDING', 'VSC ENDING'],
};

/** A small flag, drawn as the flag is, in the toned colours. */
function flagMark(ctx: Ctx, mark: 'yellow' | 'double' | 'cleared' | 'blackwhite', x: number, y: number, w: number, h: number): void {
  const c = colors();
  if (mark === 'blackwhite') {
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x, y + h);
    ctx.fill();
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.moveTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.fill();
    ctx.strokeStyle = c.dim;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    return;
  }
  if (mark === 'cleared') {
    ctx.fillStyle = c.flagYellow;
    ctx.fillRect(x, y, w / 2, h);
    ctx.fillStyle = c.throttle;
    ctx.fillRect(x + w / 2, y, w / 2, h);
    return;
  }
  ctx.fillStyle = c.flagYellow;
  ctx.fillRect(x, y, w, h);
  if (mark === 'double') {
    ctx.fillStyle = '#000';
    ctx.fillRect(x, Math.round(y + h / 2) - 1, w, 1);
  }
}

/** Draws the board, top to bottom, and says how tall it drew. */
export function drawBoard(ctx: Ctx, m: BoardModel, box: Pick<Box, 'width' | 'height'>): number {
  const c = colors();
  const W = box.width;
  const thumb = box.height < THUMB_BELOW;
  let y = 0;
  const head = (label: string) => {
    text(ctx, label, PAD, y + HEAD / 2, { size: SIZE, color: c.mute });
    y += HEAD;
  };

  // A red flag, a safety car or a VSC takes the top of the board.
  if (m.track !== 'green') {
    const ending = m.track === 'scEnd' || m.track === 'vscEnd';
    ctx.fillStyle = ending ? c.select : m.track === 'red' ? c.brake : c.flagYellow;
    ctx.fillRect(0, 0, W, BAND);
    if (ending) flagMark(ctx, 'cleared', PAD, 8, 18, 12);
    const x = ending ? PAD + 26 : PAD;
    const fg = ending ? c.ink : '#000';
    const detail = [m.since !== null ? `since lap ${m.since}` : null, m.track === 'red' && m.restart?.at ? `resumes ${m.restart.at}` : null]
      .filter(Boolean)
      .join(' · ');
    const [long, short] = BAND_LABEL[m.track];
    const room = W - x - PAD - (detail ? textWidth(ctx, detail, SIZE) + 12 : 0);
    const label = textWidth(ctx, long, 12, 700) <= room ? long : short;
    text(ctx, label, x, BAND / 2, { size: 12, weight: 700, color: fg });
    const left = W - PAD - x - textWidth(ctx, label, 12, 700) - 12;
    if (detail) text(ctx, fitText(ctx, detail, left, SIZE), W - PAD, BAND / 2, { size: SIZE, align: 'right', color: ending ? c.dim : '#000' });
    y = BAND + 4;
    if (!thumb && m.track === 'red' && m.restart?.order.length) {
      head('RESTART ORDER');
      const cell = 52;
      const across = Math.max(1, Math.floor((W - PAD * 2 + 8) / cell));
      m.restart.order.forEach((car, i) => {
        const x = PAD + (i % across) * cell;
        const cy = y + Math.floor(i / across) * ROW + ROW / 2;
        text(ctx, String(i + 1), x + 14, cy, { size: SIZE, align: 'right', color: c.mute });
        drawCode(ctx, styleOf(m.styles, car), x + 18, cy, { size: SIZE, strong: true, barHeight: 12 });
      });
      y += Math.ceil(m.restart.order.length / across) * ROW + 6;
    }
  }

  // Grip and the aid, a dash for one race control hasn't spoken of; "Yellows none" stands in for the strip.
  {
    let x = PAD;
    const cy = y + 11;
    const put = (key: string, value: string, strong: boolean) => {
      text(ctx, key, x, cy, { size: SIZE, color: c.mute });
      x += textWidth(ctx, `${key} `, SIZE);
      const weight = strong ? 700 : 400;
      text(ctx, value, x, cy, { size: SIZE, weight, color: strong ? c.ink : value === '–' ? c.faint : c.dim });
      x += textWidth(ctx, value, SIZE, weight) + 14;
    };
    if (!m.sectors.size) put('Yellows', 'none', false);
    put('Grip', m.grip ?? '–', m.grip === 'low');
    put(m.aid?.label ?? m.aidLabel, m.aid ? (m.aid.on ? 'on' : 'off') : '–', m.aid?.on === false);
    y += 22;
  }

  // The marshal sectors, only while a yellow is out.
  if (m.sectors.size) {
    const n = m.sectorCount;
    const cw = (W - PAD * 2) / n;
    for (let s = 1; s <= n; s++) {
      const x = PAD + (s - 1) * cw;
      const flag = m.sectors.get(s);
      if (flag) flagMark(ctx, flag, x + 1, y, cw - 2, 14);
      else {
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x + 1) + 0.5, y + 0.5, Math.max(1, Math.round(cw - 3)), 13);
      }
      if (flag || s === 1 || s === n) text(ctx, String(s), x + cw / 2, y + 24, { size: SIZE, align: 'center', color: flag ? c.ink : c.faint });
    }
    y += STRIP;
  }
  if (thumb) return Math.ceil(y);

  // The stewards' cases.
  hline(ctx, PAD, W - PAD, y + 1, c.quiet);
  y += 4;
  head('STEWARDS');
  if (!m.cases.length) {
    text(ctx, 'Nothing noted', PAD, y + ROW / 2, { size: SIZE, color: c.faint });
    y += ROW;
  }
  for (const line of m.cases) {
    const owed = line.stage === 'penalty';
    const strong = owed || line.stage === 'investigating' || line.stage === 'noted';
    const stage = stageLabel(line.stage, line.penalty);
    const stageWeight = strong ? 600 : 400;
    const right = W - PAD - textWidth(ctx, stage, SIZE, stageWeight) - 10;
    const across = Math.max(1, Math.floor((right - PAD) / CAR));
    const lines = Math.ceil(line.cars.length / across);
    line.cars.forEach((car, i) => {
      const x = PAD + (i % across) * CAR;
      const cy = y + Math.floor(i / across) * ROW + ROW / 2;
      const off = line.penalty !== null && !line.penalised.includes(car);
      drawCode(ctx, styleOf(m.styles, car), x, cy, { size: SIZE, strong: !off, tone: off ? 'mute' : 'ink', barHeight: 12 });
    });
    const lastY = y + (lines - 1) * ROW + ROW / 2;
    const after = PAD + Math.min(line.cars.length - (lines - 1) * across, across) * CAR + 2;
    const reason = line.reason ? partsText(sentenceCase(withCars(line.reason)), (n) => styleOf(m.styles, n).code) : line.turn ? `Turn ${line.turn}` : '';
    const said = fitText(ctx, reason, right - after, SIZE);
    if (said) text(ctx, said, after, lastY, { size: SIZE, color: c.dim });
    text(ctx, stage, W - PAD, y + ROW / 2, {
      size: SIZE,
      align: 'right',
      weight: stageWeight,
      color: strong ? c.ink : line.stage === 'after the race' ? c.dim : c.mute,
    });
    y += lines * ROW;
  }

  // Laps deleted for track limits, a tick each, and the black and white flag.
  y += 6;
  head('LAPS DELETED · TRACK LIMITS');
  if (!m.deleted.length) {
    text(ctx, 'None', PAD, y + ROW / 2, { size: SIZE, color: c.faint });
    y += ROW;
  } else {
    let x = PAD;
    for (const d of m.deleted) {
      const w = 34 + d.laps * 5 + (d.blackWhite ? 16 : 0) + 12;
      if (x > PAD && x + w > W - PAD + 12) {
        x = PAD;
        y += ROW;
      }
      const cy = y + ROW / 2;
      drawCode(ctx, styleOf(m.styles, d.car), x, cy, { size: SIZE, strong: true, barHeight: 12 });
      ctx.fillStyle = c.dim;
      for (let i = 0; i < d.laps; i++) ctx.fillRect(x + 34 + i * 5, cy - 4, 3, 9);
      if (d.blackWhite) flagMark(ctx, 'blackwhite', x + 36 + d.laps * 5, cy - 5, 12, 10);
      x += w;
    }
    y += ROW;
  }
  return Math.ceil(y + 4);
}

let measurer: Ctx | null = null;
const measuring = (): Ctx | null => (measurer ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'));

const draw = (ctx: Ctx, m: BoardModel, box: Box) => void drawBoard(ctx, m, box);

/** The board's height in a tile: the tile while it fits, more once it doesn't, for the host to mark the cut. */
export function boardExtent(m: BoardModel, box: Box): { width: number; height: number } {
  const ctx = measuring();
  if (!ctx || box.height < THUMB_BELOW) return box;
  return { width: box.width, height: drawBoard(ctx, m, box) };
}

function Board({ rows }: { rows: ReadonlyArray<Record<string, unknown>> }) {
  const styles = useDriverStyles();
  const circuit = useLive((s) => s.circuit);
  const aidLabel = useLive((s) => s.spec.chaseAid.label);
  const marshalSectors = circuit.state === 'ready' ? (circuit.marshalSectors ?? null) : null;
  const model = useMemo(() => boardModel(rows, { styles, marshalSectors, aidLabel }), [rows, styles, marshalSectors, aidLabel]);
  return <ChartCanvas model={model} draw={draw} extent={boardExtent} />;
}

function RaceStatus() {
  const view = useSql(SQL);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => view.state === 'ready' && <Board rows={view.rows} />}
    </ChartFrame>
  );
}

/** Least: the band, the conditions, the strip and three cases at 11px. Past 440 wide only the strip's cells and the reasons grow. */
const LEAST = { width: 300, height: 180 };
const FIT = { width: 440 };

export default defineComponent({
  name: 'race_status',
  title: 'Race status',
  description:
    "What race control has in force right now and who has what against them: a red flag, safety car or VSC with the restart order, the sectors under yellow, grip and the overtaking aid, the stewards' open cases and owed penalties, and laps deleted for track limits. Pick it to see where things stand; pick race_control for what was said and when.",
  args: Type.Object({}),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 0.9, min: LEAST },
  fit: FIT,
  spec: () => ({ key: 'race_status', label: 'Race status' }),
  View: RaceStatus,
});
