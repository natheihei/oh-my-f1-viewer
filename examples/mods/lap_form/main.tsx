/**
 * Lap form: each driver's last laps as a row of cells, as of the playhead. Purple is the session's best
 * lap at the time it was set, green the driver's own best so far, grey anything slower. Out laps from the
 * pits are left hollow. An example mod: see docs/MODS.md.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from 'f1a';
import { ChartCanvas, ChartFrame, colors, text, textWidth, useDriverStyles, type Box, type DriverStyle } from 'f1a/kit';

const LAPS = 8;
const SQL = `SELECT driver_number, lap_number, lap_duration, is_pit_out_lap FROM laps
  WHERE lap_duration IS NOT NULL ORDER BY date_start`;

type Mark = 'session' | 'personal' | 'slower' | 'out';
interface Row {
  number: number;
  laps: Array<{ lap: number; mark: Mark }>;
  last: number | null;
}

/** Walks the laps in the order they were set, so a purple is the best at that moment, not the best now. */
function model(rows: ReadonlyArray<Record<string, unknown>>): Row[] {
  let sessionBest = Infinity;
  const personal = new Map<number, number>();
  const byDriver = new Map<number, Row>();
  for (const r of rows) {
    const number = Number(r.driver_number);
    const duration = Number(r.lap_duration);
    const row = byDriver.get(number) ?? { number, laps: [], last: null };
    byDriver.set(number, row);
    let mark: Mark = 'slower';
    if (r.is_pit_out_lap) mark = 'out';
    else if (duration < sessionBest) mark = 'session';
    else if (duration < (personal.get(number) ?? Infinity)) mark = 'personal';
    if (mark !== 'out') {
      sessionBest = Math.min(sessionBest, duration);
      personal.set(number, Math.min(personal.get(number) ?? Infinity, duration));
    }
    row.laps.push({ lap: Number(r.lap_number), mark });
    row.last = duration;
  }
  return [...byDriver.values()].map((row) => ({ ...row, laps: row.laps.slice(-LAPS) }));
}

const time = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;

function draw(ctx: CanvasRenderingContext2D, { rows, styles }: { rows: Row[]; styles: Map<number, DriverStyle> }, box: Box): void {
  const c = colors();
  const pad = 8;
  const codeW = box.compact ? 0 : textWidth(ctx, 'WWW', 11) + 8;
  const timeW = box.compact ? 0 : textWidth(ctx, '0:00.000', 11) + 8;
  const pitch = Math.min(18, (box.height - pad * 2) / Math.max(rows.length, 1));
  const cellW = (box.width - pad * 2 - codeW - timeW) / LAPS;
  const fill: Record<Mark, string> = { session: '#a855f7', personal: '#3fb54a', slower: c.faint, out: 'transparent' };
  rows.forEach((row, i) => {
    const y = pad + i * pitch;
    const mid = y + pitch / 2;
    const style = styles.get(row.number);
    if (!box.compact) text(ctx, style?.code ?? String(row.number), pad, mid, { size: 11, color: style?.colour ?? c.dim });
    row.laps.forEach((lap, j) => {
      const x = pad + codeW + (LAPS - row.laps.length + j) * cellW;
      ctx.fillStyle = fill[lap.mark];
      ctx.fillRect(x + 1, y + 2, cellW - 2, pitch - 4);
      if (lap.mark === 'out') {
        ctx.strokeStyle = c.faint;
        ctx.strokeRect(x + 1.5, y + 2.5, cellW - 3, pitch - 5);
      }
    });
    if (!box.compact && row.last !== null) text(ctx, time(row.last), box.width - pad, mid, { size: 11, align: 'right', color: c.ink });
  });
}

function LapForm() {
  const view = useSql(SQL);
  const styles = useDriverStyles();
  // One reference until the rows or the roster change, so the canvas redraws only then.
  const board = useMemo(() => ({ rows: view.state === 'ready' ? model(view.rows) : [], styles }), [view, styles]);
  return (
    <ChartFrame needs={['timing']} views={[view]}>
      {() => <ChartCanvas model={board} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'lap_form',
  title: 'Lap form',
  description: "Each driver's last eight laps as coloured cells: session best, personal best or slower. Suggest it when the user asks who is quick right now.",
  args: Type.Object({}),
  needs: ['timing'],
  size: { aspect: 1, min: { width: 260, height: 220 } },
  spec: () => ({ key: 'lap_form', label: 'Lap form' }),
  View: LapForm,
});
