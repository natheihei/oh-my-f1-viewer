/**
 * The open session's circuit drawn large and faint, with the leader's last few seconds on it as a
 * short red trail. Positions come from `location` as of the playhead, so it shows nothing ahead.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineBackground, useLive, useSql, type CircuitView } from '../host';

interface Params {
  [key: string]: number | boolean;
  line: number;
  leader: boolean;
  trail: number;
}

interface Data {
  circuit: CircuitView;
  /** The leader's positions in the trail's window, oldest first. */
  trail: Array<{ x: number; y: number }>;
}

/** The leader as of the playhead, then its positions in the last `?2` milliseconds. `?1` is the playhead. */
export const SQL = `SELECT x, y FROM location
  WHERE date > ?1 - ?2 AND date <= ?1
    AND driver_number = (SELECT driver_number FROM position WHERE date <= ?1 AND position = 1 ORDER BY date DESC LIMIT 1)
  ORDER BY date`;

const NO_PLAYHEAD = -1;
const MARGIN = 0.08;

function rotate(x: number, y: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

export default defineBackground<Params, undefined, Data>({
  name: 'track',
  title: 'Track ghost',
  params: Type.Object({
    line: Type.Number({
      title: 'Line brightness',
      minimum: 0.02,
      maximum: 1,
      step: 0.005,
      default: 0.12,
      unit: '%',
    }),
    leader: Type.Boolean({ title: 'Leader', default: true }),
    trail: Type.Number({
      title: 'Trail',
      minimum: 0,
      maximum: 20,
      step: 1,
      default: 6,
      unit: 's',
      shownWhen: 'leader',
    }),
  }),
  useData(p) {
    const circuit = useLive((s) => s.circuit);
    const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null));
    const view = useSql(SQL, [playhead ?? NO_PLAYHEAD, Math.max(1, p.trail) * 1000]);
    const trail = useMemo(
      () =>
        view.state === 'ready'
          ? view.rows.flatMap((r) => {
              const [x, y] = [Number(r.x), Number(r.y)];
              // (0, 0) is the feed's placeholder for a car with no position yet.
              return Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0) ? [{ x, y }] : [];
            })
          : [],
      [view],
    );
    return useMemo(() => ({ circuit, trail }), [circuit, trail]);
  },
  unavailable: ({ circuit }) =>
    circuit.state === 'ready'
      ? null
      : circuit.state === 'failed'
        ? `No circuit: ${circuit.reason}`
        : circuit.state === 'loading'
          ? 'Loading the circuit'
          : 'Needs an open session',
  animated: () => false,
  draw(ctx, { width, height }, p, _state, { circuit, trail }) {
    if (circuit.state !== 'ready' || circuit.outline.x.length < 2) return;
    const { outline, rotation } = circuit;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < outline.x.length; i++) {
      const [x, y] = rotate(outline.x[i], outline.y[i], rotation);
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
    const [boxW, boxH] = [width * (1 - 2 * MARGIN), height * (1 - 2 * MARGIN)];
    const scale = Math.min(boxW / (x1 - x0 || 1), boxH / (y1 - y0 || 1));
    const left = (width - (x1 - x0) * scale) / 2;
    const top = (height - (y1 - y0) * scale) / 2;
    const place = (x: number, y: number): [number, number] => {
      const [rx, ry] = rotate(x, y, rotation);
      return [left + (rx - x0) * scale, top + (y1 - ry) * scale];
    };

    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(255,255,255,${p.line})`;
    ctx.beginPath();
    for (let i = 0; i < outline.x.length; i++) {
      const [x, y] = place(outline.x[i], outline.y[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    if (!p.leader || trail.length === 0) return;
    const shown = p.trail === 0 ? trail.slice(-1) : trail;
    shown.forEach((point, i) => {
      const [x, y] = place(point.x, point.y);
      const head = i === shown.length - 1;
      const age = 1 - (i + 1) / shown.length;
      ctx.fillStyle = `rgba(255,59,48,${head ? 0.6 : 0.45 * (1 - age) ** 2})`;
      ctx.beginPath();
      ctx.arc(x, y, head ? 2.6 : 1.4, 0, Math.PI * 2);
      ctx.fill();
    });
  },
});
