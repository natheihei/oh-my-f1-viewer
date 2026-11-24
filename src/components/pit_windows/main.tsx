/**
 * Every running car's pit stop played out at once, one row each in running order: where it would rejoin if it
 * stopped now, the places that costs, the margin either side, and the car it would come out behind.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { Displayed, defineComponent, Highlighted, keyPart, useLive, useSql } from 'omfv';
import {
  type Box,
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  colors,
  type Ctx,
  displayed,
  drawCode,
  type DriverStyle,
  hline,
  MONO_ADVANCE,
  type Neutral,
  neutralOf,
  num,
  PIT_WINDOW_SQL,
  pitWindowModel,
  styleOf,
  text,
  textWidth,
  useDriverSet,
  useDriverStyles,
} from 'omfv/kit';

const NEEDS = ['timing' as const];

/** The track status now: under a safety car or a virtual one, a stop costs less. */
export const STATUS_SQL = 'SELECT status FROM track_status ORDER BY date DESC LIMIT 1';

export interface WindowRow {
  driver: number;
  /** Position now. */
  from: number;
  /** On an in-lap or out-lap now, so there's no stop to play out. */
  pit: boolean;
  /** Everything below is null while in the pits, or without a pit loss. */
  rejoin: number | null;
  /** Places lost by stopping now. */
  lost: number | null;
  /** Seconds short of rejoining ahead of the next car up, in race order. */
  short: number | null;
  /** Seconds before the next car behind gets by as well. */
  spare: number | null;
  /** The car just ahead on the road where it would come out, and how far ahead. */
  ahead: { driver: number; by: number } | null;
  clearAir: boolean;
}

/**
 * The rows of `PIT_WINDOW_SQL` as one row per running car, in running order, with each car's stop played out by
 * `pitWindowModel`: the same ring, gaps and rejoin as the pit window chart. A car whose latest lap is an
 * in-lap, or an out-lap still running, is in the pits now. A retired car is left off.
 */
export function pitWindowsModel(rows: ReadonlyArray<Record<string, unknown>>, pitLoss: number | null): WindowRow[] {
  const latest = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    const d = num(r.driver_number);
    const lap = num(r.lap_number);
    if (d === null || lap === null) continue;
    const last = latest.get(d);
    if (!last || lap >= (num(last.lap_number) ?? 0)) latest.set(d, r);
  }
  const field = pitWindowModel(rows, -1, pitLoss).cars;
  return field
    .map((car): WindowRow => {
      const m = pitWindowModel(rows, car.driver, pitLoss);
      const r = latest.get(car.driver);
      const pit = !!r && (!!r.is_pit_in_lap || (!!r.is_pit_out_lap && r.date_end == null));
      const from = m.from!;
      const out = pit ? null : m.out;
      if (!out) return { driver: car.driver, from, pit, rejoin: null, lost: null, short: null, spare: null, ahead: null, clearAir: true };
      return {
        driver: car.driver,
        from,
        pit,
        rejoin: out.position,
        lost: out.position - from,
        short: out.short,
        spare: out.spare,
        ahead: out.behind && { driver: out.behind.driver, by: out.behind.by },
        clearAir: out.clearAir,
      };
    })
    .sort((a, b) => a.from - b.from || a.driver - b.driver);
}

/** MultiViewer's pit loss for the track status now: the safety car's or VSC's when one is out. */
export function lossNow(loss: { normal: number | null; safetyCar: number | null; virtualSafetyCar: number | null }, status: Neutral | null): number | null {
  if (status === 'SC') return loss.safetyCar;
  if (status === 'VSC') return loss.virtualSafetyCar;
  return loss.normal;
}

type Key = 'position' | 'driver' | 'rejoin' | 'cost' | 'short' | 'spare' | 'ahead' | 'air';

/** Width in characters. Every column is always drawn, and a tile too narrow lets the table run past its right edge. */
const COLUMNS: Array<{ key: Key; head: string; chars: number; thumbnail: boolean }> = [
  { key: 'position', head: 'P', chars: 2, thumbnail: true },
  // The team bar and the code, drawn as one by drawCode: 3 for the code, and a little over one for the bar and its gap.
  { key: 'driver', head: '', chars: 4.1, thumbnail: true },
  { key: 'rejoin', head: 'REJOIN', chars: 3, thumbnail: true },
  { key: 'cost', head: 'COST', chars: 3, thumbnail: true },
  { key: 'short', head: 'SHORT', chars: 4, thumbnail: false },
  { key: 'spare', head: 'SPARE', chars: 4, thumbnail: false },
  { key: 'ahead', head: 'CAR AHEAD', chars: 9, thumbnail: false },
  { key: 'air', head: 'AIR', chars: 7, thumbnail: true },
];

// As the timing tower: the same type, rows and spacing, so the two read alike side by side.
const MIN_SIZE = 11;
const MAX_SIZE = 12;
const MIN_SPACING = 1.5;
const MAX_SPACING = 3;
const PAD = 8;
const HEAD = 16;
const MIN_PITCH = 16;
const MAX_PITCH = 22;
const MAX_CARS = 22;
const THUMBNAIL_BELOW = 150;
/** A margin under this is close enough that a good or bad stop decides it: set in ink. */
const CLOSE = 1;

function widthAt(columns: typeof COLUMNS, size: number, spacing: number): number {
  const chars = columns.reduce((sum, col, i) => sum + col.chars + (i === 0 ? 0 : col.key === 'driver' ? MONO_ADVANCE : spacing), 0);
  return chars * size * MONO_ADVANCE + PAD * 2;
}
const heightAt = (rows: number, pitch: number): number => HEAD + rows * pitch + PAD;

const LEAST = { width: Math.ceil(widthAt(COLUMNS, MIN_SIZE, MIN_SPACING)), height: heightAt(MAX_CARS, MIN_PITCH) };
const MOST = { width: Math.ceil(widthAt(COLUMNS, MAX_SIZE, MAX_SPACING)), height: heightAt(MAX_CARS, MAX_PITCH) };

interface Drawn {
  rows: WindowRow[];
  styles: Map<number, DriverStyle>;
  /** The props' drivers: their rows are lifted. */
  highlighted: ReadonlySet<number>;
  /** The pit loss every row adds, and the neutralisation it's for. */
  loss: number | null;
  status: Neutral | null;
}

const thumbnail = (height: number): boolean => height < THUMBNAIL_BELOW;
const columnsOf = (small: boolean) => COLUMNS.filter((col) => !small || col.thumbnail);
const pitchOf = (m: Drawn, height: number): number => Math.min(MAX_PITCH, Math.max(MIN_PITCH, (height - HEAD - PAD) / Math.max(1, m.rows.length)));
function sizeOf(columns: typeof COLUMNS, pitch: number, width: number): number {
  let size = Math.min(MAX_SIZE, Math.floor(pitch * 0.58));
  while (size > MIN_SIZE && widthAt(columns, size, MIN_SPACING) > width) size -= 1;
  return Math.max(MIN_SIZE, size);
}

/** The tile itself while the table fits it, and past its bottom or right edge once rows and type stop shrinking. */
export function windowsExtent(m: Drawn, { width, height }: Box): { width: number; height: number } {
  if (thumbnail(height)) return { width, height };
  const pitch = pitchOf(m, height);
  const columns = columnsOf(false);
  return {
    width: Math.max(width, Math.ceil(widthAt(columns, sizeOf(columns, pitch, width), MIN_SPACING))),
    height: Math.max(height, Math.ceil(heightAt(m.rows.length, pitch))),
  };
}

/** The REJOIN head says what a stop adds: "+21.8", or "+14.2 SC" under a safety car. */
const lossHead = (m: Drawn): string => (m.loss === null ? 'REJOIN' : `+${m.loss.toFixed(1)}${m.status && m.status !== 'RED' ? ` ${m.status}` : ''}`);

function draw(ctx: Ctx, m: Drawn, { width, height }: Box): void {
  const c = colors();
  const small = thumbnail(height);
  const pad = small ? 4 : PAD;
  const head = small ? 0 : HEAD;
  const pitch = small ? Math.min(MAX_PITCH, Math.max(9, (height - pad) / Math.max(1, m.rows.length))) : pitchOf(m, height);
  const columns = columnsOf(small);
  const size = small ? Math.min(MAX_SIZE, Math.max(8, Math.floor(pitch * 0.58))) : sizeOf(columns, pitch, width);
  const ch = textWidth(ctx, '0', size);

  const room = width - pad * 2;
  const chars = columns.reduce((s, col) => s + col.chars, 0);
  const spacing = Math.min(MAX_SPACING * ch, Math.max(MIN_SPACING * ch, (room - chars * ch - MONO_ADVANCE * ch) / Math.max(1, columns.length - 2)));
  const edges = new Map<Key, { x0: number; x1: number }>();
  let at = pad;
  for (const col of columns) {
    const gap = col.key === 'driver' ? ch * MONO_ADVANCE : spacing;
    if (at > pad) at += gap;
    edges.set(col.key, { x0: at, x1: at + col.chars * ch });
    at += col.chars * ch;
  }

  if (head) {
    for (const col of columns) {
      const e = edges.get(col.key)!;
      if (col.key === 'rejoin') {
        // Under a neutralisation the loss is the news: ink and bold.
        const neutral = m.loss !== null && (m.status === 'SC' || m.status === 'VSC');
        text(ctx, lossHead(m), e.x1, head / 2 + 1, { align: 'right', color: neutral ? c.ink : c.mute, size: 9, weight: neutral ? 700 : 400 });
      } else if (col.head) text(ctx, col.head, e.x1, head / 2 + 1, { align: 'right', color: c.mute, size: 9 });
    }
  }

  m.rows.forEach((row, i) => {
    const top = head + i * pitch;
    if (small && top + pitch > height) return;
    const y = top + pitch / 2 + 0.5;
    const lifted = m.highlighted.has(row.driver);
    if (lifted) {
      ctx.fillStyle = c.select;
      ctx.fillRect(0, top + 1, width, pitch - 1);
    }
    if (!small) hline(ctx, pad, width - pad, top, c.quiet);
    const style = styleOf(m.styles, row.driver);
    const played = row.rejoin !== null;
    for (const col of columns) {
      const { x0, x1 } = edges.get(col.key)!;
      switch (col.key) {
        case 'position':
          text(ctx, String(row.from), x1, y, { align: 'right', color: c.ink, size });
          break;
        case 'driver':
          drawCode(ctx, style, x0, y, { size, strong: lifted, barHeight: pitch * 0.56 });
          break;
        case 'rejoin':
          if (row.pit) text(ctx, 'PIT', x1, y, { align: 'right', color: c.dim, size });
          else if (played) text(ctx, `P${row.rejoin}`, x1, y, { align: 'right', color: c.ink, size });
          else text(ctx, '–', x1, y, { align: 'right', color: c.faint, size });
          break;
        case 'cost':
          if (!played) break;
          if (row.lost === 0) text(ctx, '–', x1, y, { align: 'right', color: c.ink, size, weight: 700 });
          else text(ctx, `▼${row.lost}`, x1, y, { align: 'right', color: c.dim, size });
          break;
        case 'short':
        case 'spare': {
          if (!played) break;
          const v = row[col.key];
          if (v === null) {
            text(ctx, '–', x1, y, { align: 'right', color: c.faint, size });
            break;
          }
          // As shown, so 0.97 doesn't read as a bold 1.0.
          const close = Math.round(v * 10) / 10 < CLOSE;
          text(ctx, v.toFixed(1), x1, y, { align: 'right', size, color: close ? c.ink : c.dim, weight: close ? 700 : 400 });
          break;
        }
        case 'ahead':
          if (!played) break;
          if (!row.ahead) {
            text(ctx, '–', x1, y, { align: 'right', color: c.faint, size });
            break;
          }
          drawCode(ctx, styleOf(m.styles, row.ahead.driver), x0, y, { size, tone: 'dim', barHeight: pitch * 0.56 });
          text(ctx, row.ahead.by.toFixed(1), x1, y, { align: 'right', size, color: c.dim });
          break;
        case 'air':
          if (!played) break;
          text(ctx, row.clearAir ? 'clear' : 'traffic', x1, y, { align: 'right', size, color: row.clearAir ? c.dim : c.ink, weight: row.clearAir ? 400 : 700 });
          break;
      }
    }
  });
}

function PitWindows({ props }: { props: { drivers?: number[]; drivers_to_display?: number[] } }) {
  const view = useSql(PIT_WINDOW_SQL);
  const statusView = useSql(STATUS_SQL);
  const styles = useDriverStyles();
  const circuit = useLive((s) => circuitMessage(s.circuit));
  const normal = useLive((s) => (s.circuit.state === 'ready' ? s.circuit.pitLoss.normal : null));
  const safetyCar = useLive((s) => (s.circuit.state === 'ready' ? s.circuit.pitLoss.safetyCar : null));
  const virtualSafetyCar = useLive((s) => (s.circuit.state === 'ready' ? s.circuit.pitLoss.virtualSafetyCar : null));
  const highlighted = useDriverSet(props.drivers);
  const shown = props.drivers_to_display;
  const status = statusView.state === 'ready' ? neutralOf(statusView.rows[0]?.status) : null;
  const loss = lossNow({ normal, safetyCar, virtualSafetyCar }, status);
  const model = useMemo(
    // Every car's stop is played out against the whole field, then only those to draw are kept.
    () => (view.state === 'ready' ? { rows: displayed(pitWindowsModel(view.rows, loss), shown), styles, highlighted, loss, status } : null),
    [view, loss, styles, highlighted, shown, status],
  );
  return (
    <ChartFrame needs={NEEDS} waits={[circuit]} views={[view, statusView]}>
      {() => model && <ChartCanvas model={model} draw={draw} extent={windowsExtent} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'pit_windows',
  title: 'Pit windows',
  description:
    "Every running car's pit stop if it stopped now, one row each: where it would rejoin, the places that costs, how many seconds short of the place ahead and how many spare, and the car it would come out behind and whether that is traffic. Suggest it for who in the field can stop cheaply, or who would land in traffic; pit_window is for one driver's stop.",
  args: Type.Object({ drivers_to_display: Displayed(', from the running cars'), drivers: Highlighted() }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: Math.round((MOST.width / MOST.height) * 100) / 100, min: LEAST },
  fit: MOST,
  spec: ({ drivers_to_display, drivers }) => ({
    key: drivers_to_display || drivers ? `pit_windows:${keyPart(drivers_to_display)}:${keyPart(drivers, 'none')}` : 'pit_windows',
    label: 'Pit windows',
    drivers: drivers_to_display ?? drivers,
  }),
  View: PitWindows,
});
