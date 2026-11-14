/** The grid and the components in it. Mouse edits arrive as host writes, like any other change. */
import { Component, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { GridSurface, type TileState } from '../layout/GridSurface';
import type { ComponentSpec, Rect } from '../layout/model';
import { GRID_COLUMNS, GRID_ROWS } from '../layout/model';
import { useLayout } from '../layout/store';
import { Stage, type TileComponent } from '../layout/Stage';
import { useBuild } from './build';
import { fillTitle, useDriverStyles } from './drivers';
import { componentOf, useComponents } from './components';
import { fitProps, health, healthOps, type PlaceHealth } from './health';
import { layoutOps } from './layoutOps';
import { useLive } from './live';
import { previewScope, tileLookAhead, useTileLookAhead } from './lookAhead';
import { reportTileError } from './mods';
import { useHiddenPast } from './overflow';
import { setGridFrame, useSuggestions } from './suggestions';

/** A place without its state: what's drawn where. Null where nothing is reported, outside a tile or preview. */
type Place = Pick<PlaceHealth, 'scope' | 'where' | 'type' | 'label'>;

interface BoundaryProps {
  type: string;
  /** The component's code: a new version, such as a mod saved again, gets a fresh try. */
  version: unknown;
  place: Place | null;
  /** Props the component's args no longer accept, which it draws without. */
  dropped: string[];
  children: ReactNode;
}

/**
 * Stands in for a component that isn't drawing, and says why. On a tile, a button attaches the error to
 * the viewer's next message, whatever the agent is doing: it only joins `live.attached`.
 */
function TileProblem({ place, state, text }: { place: Place | null; state: 'needs_props' | 'error'; text: string }) {
  return (
    <div className="tile-warning tile-problem" data-testid="tile-problem" data-problem={state} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div>
        <div className="tile-warning-title">! error</div>
        <div>{text}</div>
      </div>
      {place?.where === 'tile' ? (
        <button type="button" className="tile-warning-allow" data-testid="attach-error" onClick={() => healthOps.attach({ scope: place.scope })}>
          Attach error to agent
        </button>
      ) : null}
    </div>
  );
}

/** Keeps a component that throws while drawing inside its own tile, so it can't take the app down. */
class TileBoundary extends Component<BoundaryProps, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    reportTileError(this.props.type, error);
    this.report();
  }

  componentDidMount() {
    this.report();
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.error !== null && previous.version !== this.props.version) this.setState({ error: null });
    else this.report();
  }

  /** Says how the place stands, once what's on screen is settled. */
  private report() {
    const { place, version, dropped } = this.props;
    if (!place) return;
    const { error } = this.state;
    health.report({ ...place, state: error !== null ? 'error' : 'drawn', missing: [], dropped, message: error }, version);
  }

  render() {
    return this.state.error !== null ? <TileProblem place={this.props.place} state="error" text={`This tile stopped: ${this.state.error}`} /> : this.props.children;
  }
}

/** Asks the viewer before a tile that looks ahead of the playhead is drawn. Stands in for it until they allow it. */
function LookAheadWarning({ scope }: { scope: string }) {
  return (
    <div className="tile-warning" data-testid="look-ahead-warning" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div>
        <div className="tile-warning-title">! spoiler</div>
        <div>This tile looks ahead of where you are.</div>
      </div>
      <button type="button" className="tile-warning-allow" data-testid="look-ahead-allow" onClick={() => tileLookAhead.approve(scope)}>
        Allow
      </button>
    </div>
  );
}

/**
 * Holds a drawn component and says, with a faded edge and a quiet "more" mark, when the component has
 * outgrown its tile: its content runs past the bottom or the right. One mark in the bottom right corner
 * names both ways: "more ▾", "more ▸" or "more ▾▸".
 */
function ViewFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { below, right } = useHiddenPast(ref);
  return (
    <>
      <div ref={ref} className="view-frame">
        {children}
      </div>
      {below || right ? (
        <div className="overflow-mark" data-testid="overflow-mark" data-below={below || undefined} data-right={right || undefined} aria-hidden>
          {below ? <div className="overflow-fade-below" /> : null}
          {right ? <div className="overflow-fade-right" /> : null}
          <span className="overflow-mark-label">
            more {below ? '▾' : ''}
            {right ? '▸' : ''}
          </span>
        </div>
      ) : null}
    </>
  );
}

/**
 * Draws a spec with its registered component, or `fallback` if none is registered under its type.
 * `scope` names the tile or preview it draws in, which is what a look-ahead approval belongs to. A
 * component that declares `looksAhead` isn't drawn there until the viewer allows it.
 */
export function ComponentView({ spec, scope = null, fallback = null }: { spec: ComponentSpec; scope?: string | null; fallback?: ReactNode }) {
  // Re-renders when a mod's component is replaced, wherever this is drawn.
  useComponents((s) => s.list);
  const definition = componentOf(spec.type);
  // Props from before an edit may not fit the component's new args: it keeps those that do.
  const fit = useMemo(() => (definition ? fitProps(definition.args, spec.props) : null), [definition, spec.props]);
  useEffect(() => {
    if (scope == null) return;
    return () => {
      tileLookAhead.forget(scope);
      health.forget(scope);
    };
  }, [scope]);
  const allowed = useTileLookAhead((s) => scope != null && s.approved[scope] === true);
  const View = definition?.View;
  const place = useMemo<Place | null>(
    () => (scope != null ? { scope, where: scope === previewScope(spec.key) ? 'strip' : 'tile', type: spec.type, label: spec.label } : null),
    [scope, spec.key, spec.type, spec.label],
  );
  const waiting = !!View && !fit?.message && definition?.looksAhead === true && !allowed;
  // What isn't drawn reports here. What is, reports from its boundary, once it has drawn or thrown.
  useEffect(() => {
    if (!place || !View || !fit) return;
    if (fit.message) health.report({ ...place, state: 'needs_props', missing: fit.missing, dropped: fit.dropped, message: fit.message }, View);
    else if (waiting) health.report({ ...place, state: 'waiting', missing: [], dropped: fit.dropped, message: null }, View);
  }, [place, View, fit, waiting]);
  useEffect(() => {
    if (place && !View) health.forget(place.scope);
  }, [place, View]);
  if (!View || !fit) return <>{fallback}</>;
  if (fit.message) return <TileProblem place={place} state="needs_props" text={fit.message} />;
  if (waiting) return scope != null ? <LookAheadWarning scope={scope} /> : null;
  return (
    <ViewFrame>
      <TileBoundary type={spec.type} version={View} place={place} dropped={fit.dropped}>
        <View props={fit.props} label={spec.label} />
      </TileBoundary>
    </ViewFrame>
  );
}

const onMove = (tile: string, rect: Rect) => layoutOps.move({ tile, rect });
const onSwap = (a: string, b: string) => layoutOps.swap({ a, b });
const onClose = (tile: string) => void layoutOps.remove({ tiles: [tile] });

const percent = (n: number, of: number) => `${(n / of) * 100}%`;

/** Where a dragged suggestion would land. Its box also tells suggestions where the grid is. */
function DropPreview() {
  const drop = useSuggestions((s) => s.drop);
  return (
    <div ref={setGridFrame} className="drop-frame">
      {drop ? (
        <div
          className="drop-preview"
          data-testid="drop-preview"
          style={{
            left: percent(drop.x, GRID_COLUMNS),
            top: percent(drop.y, GRID_ROWS),
            width: percent(drop.w, GRID_COLUMNS),
            height: percent(drop.h, GRID_ROWS),
          }}
        />
      ) : null}
    </div>
  );
}

const NO_MARKS: Record<string, string> = {};

// One wrapper per component name for good, because a new one would remount every tile showing it.
const wrappers = new Map<string, TileComponent>();
function wrapperOf(name: string): TileComponent {
  let wrapper = wrappers.get(name);
  if (!wrapper) {
    wrapper = ({ spec, tileId }) => <ComponentView spec={spec} scope={tileId} />;
    wrappers.set(name, wrapper);
  }
  return wrapper;
}

/** Every tile, each drawn with the registered component its spec names. */
export function Grid() {
  const components = useComponents((s) => s.list);
  const registry = useMemo(() => Object.fromEntries(components.map(({ name }) => [name, wrapperOf(name)])), [components]);
  const highlight = useSuggestions((s) => s.highlight);
  const building = useBuild((s) => s.active);
  const changes = useBuild((s) => s.changes);
  // What build mode changed, by component name: a new mod's tile is a draft, a changed one is edited.
  const marks = useMemo(
    () => (building ? Object.fromEntries(changes.filter((c) => c.change !== 'deleted').map((c) => [c.name, c.change === 'added' ? 'draft' : 'edited'])) : NO_MARKS),
    [building, changes],
  );
  const approved = useTileLookAhead((s) => s.approved);
  const tiles = useLayout((s) => s.tiles);
  const audio = useLive((s) => s.audio);
  const muted = useLive((s) => s.volume === 0);
  const streams = useLive((s) => s.streams);
  // What each header's slots say. An approval outlives an edit that drops `looksAhead`, but the header
  // only says so while it applies.
  const states = useMemo(() => {
    const ahead = new Set(components.filter((c) => c.looksAhead).map((c) => c.name));
    const out: Record<string, TileState> = {};
    for (const t of tiles) {
      const state: TileState = {};
      if (approved[t.id] && ahead.has(t.component.type)) state.ahead = true;
      if (marks[t.component.type]) state.mark = marks[t.component.type];
      if (t.component.type === 'video') {
        const feed = t.component.key;
        if (feed === audio) state.audio = muted ? 'muted' : 'on';
        const status = streams[feed]?.status;
        if (status === 'error') {
          state.status = 'error';
          state.error = true;
        } else if (status === 'resolving' || status === 'loading') state.status = 'load';
        else if (status === 'syncing') state.status = 'sync';
      }
      out[t.id] = state;
    }
    return out;
  }, [approved, components, tiles, audio, muted, streams, marks]);
  // Titles draw their drivers' codes from the roster, so they're drawn again when it changes.
  const styles = useDriverStyles();
  const drawTitle = useCallback((el: HTMLElement, component: ComponentSpec) => fillTitle(el, component, styles), [styles]);
  return (
    <>
      <Stage registry={registry} highlight={highlight} marks={marks} />
      <GridSurface onMove={onMove} onSwap={onSwap} onClose={onClose} states={states} drawTitle={drawTitle} />
      <DropPreview />
    </>
  );
}
