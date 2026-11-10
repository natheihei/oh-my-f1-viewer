/** Each pit stop so far, newest first: lap, driver, tyre fitted, time in the pit lane and time stationary. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  compactSmall,
  codeOf,
  colors,
  compoundLetter,
  hline,
  num,
  styleOf,
  text,
  textWidth,
  tyreColour,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/**
 * Each stop with the tyre fitted. `pit.lap_number` is the in-lap, so the set fitted is the stint that
 * starts on the lap after it. `filter` limits it to some drivers.
 */
export const sqlFor = (count: number) => `
SELECT p.driver_number, p.lap_number, p.date, COALESCE(p.lane_duration, p.pit_duration) AS lane, p.stop_duration,
  (SELECT s.compound FROM stints s WHERE s.driver_number = p.driver_number AND s.lap_start = p.lap_number + 1) AS compound
FROM pit p
${count ? `WHERE p.driver_number IN (${Array.from({ length: count }, () => '?').join(', ')})` : ''}
ORDER BY p.date DESC, p.lap_number DESC`;

export interface Stop {
  driver: number;
  lap: number;
  /** The tyre fitted, or null until its stint shows. */
  compound: string | null;
  /** Seconds from pit entry to pit exit. */
  lane: number | null;
  /** Seconds stationary. */
  stop: number | null;
}

export interface StopsModel {
  /** Newest first. */
  stops: Stop[];
  /** Some seasons have no stationary time: the column hides when no stop has one. */
  hasStop: boolean;
  /** The lane bars' scale, in seconds. */
  lane: [number, number] | null;
}

/** The rows of the query as stops, newest first, with the scale their lane bars share. */
export function stopsModel(rows: ReadonlyArray<Record<string, unknown>>): StopsModel {
  const stops = rows.flatMap((r): Stop[] => {
    const driver = num(r.driver_number);
    const lap = num(r.lap_number);
    if (driver === null || lap === null) return [];
    return [{ driver, lap, compound: typeof r.compound === 'string' ? r.compound : null, lane: num(r.lane), stop: num(r.stop_duration) }];
  });
  const lanes = stops.map((s) => s.lane).filter((l): l is number => l !== null && l > 0);
  // The bars start a little under the quickest, so the differences between stops show.
  const lane: [number, number] | null = lanes.length
    ? [Math.max(0, Math.floor(Math.min(...lanes)) - 2), Math.max(Math.ceil(Math.max(...lanes)), Math.floor(Math.min(...lanes)) + 3)]
    : null;
  return { stops, hasStop: stops.some((s) => s.stop !== null), lane };
}

interface Drawn extends StopsModel {
  styles: Map<number, DriverStyle>;
}

function draw(ctx: Ctx, m: Drawn, box: Box): void {
  const { width, height } = box;
  const compact = compactSmall(box);
  const c = colors();
  const pad = compact ? 4 : 8;
  const head = compact ? 0 : 16;
  const pitch = compact ? Math.max(5, Math.min(12, (height - pad) / Math.max(1, m.stops.length))) : Math.min(20, Math.max(15, (height - head - 4) / 6));
  const size = 10;
  const ch = textWidth(ctx, '0', size);

  // LAP, the driver, the tyre fitted (its letter needs no heading), then the lane bar with its time, then the stop time.
  const lapX = pad;
  const codeX = pad + 4.5 * ch;
  const tyreX = codeX + 4.5 * ch;
  const stopW = m.hasStop && !compact ? 5 * ch : 0;
  const barX = compact ? pad + 4 : tyreX + 2.5 * ch;
  const valueW = compact ? 0 : 5.5 * ch;
  const barEnd = width - pad - stopW - (stopW ? 1.5 * ch : 0) - valueW;

  if (head) {
    const style = { color: c.faint, size: 9 };
    text(ctx, 'LAP', lapX, head / 2 + 1, style);
    text(ctx, 'LANE', barX, head / 2 + 1, style);
    if (stopW) text(ctx, 'STOP', width - pad, head / 2 + 1, { ...style, align: 'right' });
  }

  const [lo, hi] = m.lane ?? [0, 1];
  // With more stops than fit, the last line says how many are left out.
  const room = height - head - (compact ? pad : 2);
  const fit = Math.floor(room / pitch);
  const shown = Math.max(0, compact || m.stops.length <= fit ? fit : Math.floor((room - 12) / pitch));
  m.stops.slice(0, shown).forEach((s, i) => {
    const top = head + (compact ? pad / 2 : 0) + i * pitch;
    const y = top + pitch / 2 + 0.5;
    const style = styleOf(m.styles, s.driver);
    if (!compact) {
      hline(ctx, pad, width - pad, top);
      text(ctx, `L${s.lap}`, lapX, y, { size });
      text(ctx, style.code, codeX, y, { color: c.ink, size, weight: 600 });
      if (s.compound) text(ctx, compoundLetter(s.compound), tyreX, y, { color: tyreColour(s.compound), size, weight: 600 });
    } else if (s.compound) {
      ctx.fillStyle = tyreColour(s.compound);
      ctx.fillRect(pad, top + pitch * 0.2, 2, pitch * 0.6);
    }
    if (s.lane !== null && barEnd > barX) {
      const w = Math.max(1.5, ((Math.min(s.lane, hi) - lo) / (hi - lo)) * (barEnd - barX));
      const h = Math.max(2, Math.round(pitch * (compact ? 0.6 : 0.45)));
      ctx.fillStyle = style.colour;
      ctx.fillRect(barX, top + (pitch - h) / 2, w, h);
      if (!compact) text(ctx, s.lane.toFixed(1), barX + w + 4, y, { color: c.ink, size });
    }
    if (stopW && s.stop !== null) text(ctx, s.stop.toFixed(1), width - pad, y, { align: 'right', color: c.ink, size });
  });
  const hidden = m.stops.length - shown;
  if (!compact && hidden > 0 && shown > 0) {
    text(ctx, `${hidden} earlier`, width - pad, height - 3, { align: 'right', color: c.faint, size: 9, baseline: 'bottom' });
  }
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  description: 'Drivers to show, as car numbers. Left out, it shows everyone.',
});

function PitStops({ props }: { props: { drivers?: number[] } }) {
  const drivers = props.drivers ?? [];
  const view = useSql(sqlFor(drivers.length), drivers);
  const styles = useDriverStyles();
  const model = useMemo(() => (view.state === 'ready' ? { ...stopsModel(view.rows), styles } : null), [view, styles]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'pit_stops',
  title: 'Pit stops',
  description:
    'Each pit stop so far, newest first: the lap, the tyre fitted, time in the pit lane and time stationary. Suggest it when the user asks how a stop went.',
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 1.6, min: [6, 5] },
  spec: ({ drivers }) => ({
    key: `pit_stops:${drivers?.join('-') ?? 'all'}`,
    label: drivers?.length ? `Pit stops ${drivers.map(codeOf).join(' · ')}` : 'Pit stops',
  }),
  View: PitStops,
});
