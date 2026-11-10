/**
 * What a chart shows instead of itself while it can't draw. Each message only says what's missing,
 * never anything about how the session is going.
 */
import type { CircuitView, Dataset, SessionDataView, SqlView } from '../../../host';

/** Why the session data can't serve these datasets, or null when it can. */
export function dataMessage(data: SessionDataView, needs: readonly Dataset[]): string | null {
  switch (data.state) {
    case 'idle':
      return 'No session open';
    case 'unsupported':
    case 'failed':
      return data.reason;
    case 'loading':
      return 'Loading session data…';
  }
  for (const dataset of needs) {
    const { state, reason } = data.coverage.datasets[dataset];
    if (state === 'absent') return reason ?? `No ${dataset} data for this session`;
    if (state === 'failed') return reason ?? `The ${dataset} data failed to load`;
    if (state === 'loading') return `Loading ${dataset} data…`;
  }
  return null;
}

/** Why the queries can't be drawn yet, or null when they can. */
export function viewMessage(views: readonly SqlView[]): string | null {
  const failed = views.find((v) => v.state === 'failed');
  if (failed) return `The query failed: ${failed.reason}`;
  if (views.some((v) => v.state === 'loading')) return '';
  if (views.every((v) => v.state === 'ready' && v.rows.length === 0)) return 'No data yet';
  return null;
}

/** Why the circuit can't be used yet, or null when it can. A stale copy still serves. */
export function circuitMessage(circuit: CircuitView): string | null {
  switch (circuit.state) {
    case 'idle':
      return 'No session open';
    case 'loading':
      return 'Loading the circuit…';
    case 'failed':
      return `No circuit data. ${circuit.reason}`;
    case 'ready':
      return null;
  }
}
