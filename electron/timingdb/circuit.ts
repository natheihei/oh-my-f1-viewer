/**
 * A session's circuit, from MultiViewer's public API: its outline, corners and pit loss. It's a third-party
 * service, so its answer is checked before it's kept, and the last good copy stays readable if it fails.
 */
import type { Circuit, CircuitCorner, CircuitView } from '../../shared/sessionData';

/** Only the circuit key and year go in the request. */
export const circuitUrl = (circuitKey: number, year: number): string => `https://api.multiviewer.app/api/v1/circuits/${circuitKey}/${year}`;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Seconds from a string such as "20.81", or a number. Null for anything else, or a loss that can't be. */
function seconds(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return finite(n) && n > 0 ? n : null;
}

function corner(raw: unknown): CircuitCorner | null {
  const c = raw as { number?: unknown; angle?: unknown; length?: unknown; trackPosition?: { x?: unknown; y?: unknown } } | null;
  if (!c || typeof c !== 'object') return null;
  const { number, angle, length } = c;
  const x = c.trackPosition?.x;
  const y = c.trackPosition?.y;
  if (!finite(number) || !finite(x) || !finite(y)) return null;
  return { number, x, y, angle: finite(angle) ? angle : 0, distance: finite(length) ? length : 0 };
}

/**
 * MultiViewer's answer as a `Circuit`, or null when it isn't one: the outline is the part that can't be
 * missing. A corner that doesn't read is left out, and a pit loss that doesn't is null.
 */
export function parseCircuit(raw: unknown, circuitKey: number, now: number): Circuit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.circuitKey != null && Number(r.circuitKey) !== circuitKey) return null;
  const { x, y } = r;
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length < 2) return null;
  if (!x.every(finite) || !y.every(finite)) return null;
  const loss = (r.pitLoss && typeof r.pitLoss === 'object' ? r.pitLoss : {}) as Record<string, unknown>;
  return {
    circuitKey,
    name: typeof r.circuitName === 'string' && r.circuitName.trim() ? r.circuitName.trim() : `Circuit ${circuitKey}`,
    refreshedAt: now,
    outline: { x: [...x], y: [...y] },
    corners: (Array.isArray(r.corners) ? r.corners : []).map(corner).filter((c): c is CircuitCorner => c !== null),
    rotation: finite(r.rotation) ? r.rotation : 0,
    pitLoss: { normal: seconds(loss.normal), safetyCar: seconds(loss.sc), virtualSafetyCar: seconds(loss.vsc) },
  };
}

export interface CircuitRefresh {
  load(circuitKey: number): Promise<Circuit | null>;
  save(circuit: Circuit): Promise<void>;
  /** MultiViewer's answer as JSON. Throws if it couldn't be fetched. */
  fetch(circuitKey: number, year: number): Promise<unknown>;
  publish(view: CircuitView): void;
  /** True once the session this is for has closed: nothing more is published. */
  stale(): boolean;
  now(): number;
}

/**
 * Publishes the cached copy at once if there is one, then fetches and publishes a fresh one. If that
 * fails, the cached copy stays with the `reason`, and without one the circuit has `failed`.
 */
export async function refreshCircuit(circuitKey: number, year: number, deps: CircuitRefresh): Promise<void> {
  const cached = await deps.load(circuitKey).catch(() => null);
  if (deps.stale()) return;
  if (cached) deps.publish({ state: 'ready', reason: null, ...cached });
  let reason: string;
  try {
    const fresh = parseCircuit(await deps.fetch(circuitKey, year), circuitKey, deps.now());
    if (fresh) {
      await deps.save(fresh).catch((e: Error) => console.warn('[timingdb] circuit not saved:', e.message));
      if (!deps.stale()) deps.publish({ state: 'ready', reason: null, ...fresh });
      return;
    }
    reason = "MultiViewer's circuit data wasn't in the expected shape.";
  } catch (e) {
    reason = `The circuit couldn't be fetched from MultiViewer: ${(e as Error).message}`;
  }
  if (deps.stale()) return;
  deps.publish(cached ? { state: 'ready', ...cached, reason } : { state: 'failed', reason });
}
