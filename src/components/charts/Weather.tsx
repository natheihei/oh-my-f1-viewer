/** Track and air temperature, wind and humidity through the session, each on its own scale, and rain as a strip. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import { ChartCanvas, ChartFrame, colors, compactSmall, dot, linear, num, polyline, text, textWidth, type Box, type Ctx } from './kit';

const NEEDS = ['timing' as const];

export const SQL = `SELECT date, track_temperature, air_temperature, wind_speed, humidity, rainfall FROM weather ORDER BY date`;

/**
 * Each measure: its label, column, unit, decimals, and the least span its scale shows, so noise stays
 * flat. The feed sometimes sends a reading of 0 between real ones (track temperature, on session
 * 11396): where 0 can't be real, it's left out.
 */
const MEASURES = [
  { label: 'TRACK', column: 'track_temperature', unit: '°C', digits: 1, span: 4, zero: false },
  { label: 'AIR', column: 'air_temperature', unit: '°C', digits: 1, span: 2, zero: false },
  { label: 'WIND', column: 'wind_speed', unit: 'm/s', digits: 1, span: 2, zero: true },
  { label: 'HUMID', column: 'humidity', unit: '%', digits: 0, span: 6, zero: false },
] as const;

export interface Series {
  label: string;
  unit: string;
  digits: number;
  points: Array<{ t: number; v: number }>;
  /** The scale, at least the measure's span wide, centred on what it covers. */
  range: [number, number];
  current: number | null;
}

export interface WeatherModel {
  from: number;
  to: number;
  series: Series[];
  /** Stretches when rainfall was reported, each lasting until the next reading. */
  rain: Array<[number, number]>;
  /** The latest reading reports rain. Null without one. */
  raining: boolean | null;
}

/** The rows of `SQL` as one line per measure and the rain strip. */
export function weatherModel(rows: ReadonlyArray<Record<string, unknown>>): WeatherModel {
  const timed = rows.filter((r) => num(r.date) !== null);
  const from = num(timed[0]?.date) ?? 0;
  const to = Math.max(num(timed.at(-1)?.date) ?? 0, from + 1);
  const series = MEASURES.map(({ label, column, unit, digits, span, zero }): Series => {
    const points = timed.flatMap((r) => {
      const v = num(r[column]);
      return v === null || (v === 0 && !zero) ? [] : [{ t: num(r.date)!, v }];
    });
    const values = points.map((p) => p.v);
    const lo = values.length ? Math.min(...values) : 0;
    const hi = values.length ? Math.max(...values) : 0;
    const half = Math.max(span, hi - lo) / 2;
    const middle = (lo + hi) / 2;
    return { label, unit, digits, points, range: [middle - half, middle + half], current: points.at(-1)?.v ?? null };
  });
  const rain: Array<[number, number]> = [];
  timed.forEach((r, i) => {
    if (!num(r.rainfall)) return;
    const start = num(r.date)!;
    const end = num(timed[i + 1]?.date) ?? to;
    const last = rain.at(-1);
    if (last && last[1] === start) last[1] = end;
    else rain.push([start, end]);
  });
  const latest = timed.at(-1);
  return { from, to, series, rain, raining: latest ? Boolean(num(latest.rainfall)) : null };
}

function draw(ctx: Ctx, m: WeatherModel, box: Box): void {
  const { width, height } = box;
  const compact = compactSmall(box);
  const c = colors();
  const pad = compact ? 4 : 8;
  const labelW = compact ? 0 : textWidth(ctx, 'HUMID', 10) + 10;
  const valueW = compact ? 0 : textWidth(ctx, '00.0 m/s', 11) + 10;
  const left = pad + labelW;
  const right = width - pad - valueW;
  const rows = m.series.length + 1;
  const pitch = (height - pad * 2) / rows;
  const x = linear([m.from, m.to], [left, right]);

  m.series.forEach((s, i) => {
    const top = pad + i * pitch;
    const mid = top + pitch / 2;
    const inset = Math.min(compact ? 2 : 4, pitch * 0.15);
    const y = linear(s.range, [top + pitch - inset, top + inset]);
    if (!compact) text(ctx, s.label, pad, mid, { size: 10 });
    polyline(
      ctx,
      s.points.map((p) => [x(p.t), y(p.v)] as const),
      { color: c.dim, width: compact ? 1 : 1.2 },
    );
    const end = s.points.at(-1);
    if (end) dot(ctx, x(end.t), y(end.v), compact ? 1.5 : 2, c.ink);
    if (!compact && s.current !== null) text(ctx, `${s.current.toFixed(s.digits)} ${s.unit}`, width - pad, mid, { align: 'right', color: c.ink, size: 11 });
  });

  // Rain: a strip that fills while rainfall is reported.
  const top = pad + m.series.length * pitch;
  const mid = top + pitch / 2;
  const h = Math.min(8, Math.max(3, pitch * 0.4));
  ctx.fillStyle = '#161616';
  ctx.fillRect(left, mid - h / 2, right - left, h);
  ctx.fillStyle = c.wet;
  for (const [a, b] of m.rain) ctx.fillRect(x(a), mid - h / 2, Math.max(1, x(b) - x(a)), h);
  if (compact) return;
  text(ctx, 'RAIN', pad, mid, { size: 10 });
  if (m.raining !== null) text(ctx, m.raining ? 'rain' : 'dry', width - pad, mid, { align: 'right', color: c.ink, size: 11 });
}

function Weather() {
  const view = useSql(SQL);
  const model = useMemo(() => (view.state === 'ready' ? weatherModel(view.rows) : null), [view]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'weather',
  title: 'Weather',
  description:
    'Track and air temperature, wind, humidity and rain, with how each has moved through the session. Suggest it when the user asks about rain or conditions.',
  args: Type.Object({}),
  needs: NEEDS,
  size: { aspect: 1.6, min: [6, 5] },
  spec: () => ({ key: 'weather', label: 'Weather' }),
  View: Weather,
});
