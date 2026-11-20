/** The shell every chart shares: it says what's missing instead of drawing, and keeps a broken chart in its tile. */
import { Component, type ReactNode } from 'react';
import { useLive, type Dataset, type SqlView } from '../host';
import { dataDetail, dataMessage, viewMessage } from './status';

interface BoundaryProps {
  /** Trying again when these change: a chart that broke on some data may draw the next. */
  views: readonly SqlView[];
  children: ReactNode;
}

class ChartBoundary extends Component<BoundaryProps, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.error && previous.views.some((v, i) => v !== this.props.views[i])) this.setState({ error: null });
  }

  render() {
    return this.state.error !== null ? <div className="chart-message">This chart stopped: {this.state.error}</div> : this.props.children;
  }
}

/**
 * Draws `children` once the session has the datasets the chart `needs`, anything else it `waits` on is
 * there, and every view has rows, and a short message until then. `children` is a function, so the
 * chart's own work runs inside the boundary.
 *
 * `waits` holds what else the chart needs, as a message while it's missing or null once it's there, such
 * as `circuitMessage(circuit)`. The first message shows, after the session data's own.
 */
export function ChartFrame({
  needs,
  waits = [],
  views,
  children,
}: {
  needs: readonly Dataset[];
  waits?: ReadonlyArray<string | null>;
  views: readonly SqlView[];
  children: () => ReactNode;
}) {
  // A string, so the frame re-renders when the message changes, not on every revision.
  const data = useLive((s) => dataMessage(s.sessionData, needs));
  const detail = useLive((s) => (data !== null ? dataDetail(s.sessionData) : null));
  const message = data ?? waits.find((w) => w !== null) ?? viewMessage(views);
  return (
    <div className="tile">
      {message !== null ? (
        message ? (
          <div className={`chart-message${detail ? ' chart-message-detail' : ''}`} title={detail ?? undefined}>
            {message}
          </div>
        ) : null
      ) : (
        <ChartBoundary views={views}>
          <Run render={children} />
        </ChartBoundary>
      )}
    </div>
  );
}

/** Calls `render` while rendering inside the boundary, so what it throws is caught there. */
function Run({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}
