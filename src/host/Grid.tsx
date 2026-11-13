/** The grid and the components in it. Mouse edits arrive as host writes, like any other change. */
import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react';
import Value from 'typebox/value';
import { GridSurface, type TileState } from '../layout/GridSurface';
import type { ComponentSpec, Rect } from '../layout/model';
import { allTiles, GRID_COLUMNS, GRID_ROWS } from '../layout/model';
import { useLayout } from '../layout/store';
import { Stage, type TileComponent } from '../layout/Stage';
import { useBuild } from './build';
import { componentOf, useComponents } from './components';
import { layoutOps } from './layoutOps';
import { useLive } from './live';
import { tileLookAhead, useTileLookAhead } from './lookAhead';
import { reportTileError } from './mods';
import { useHiddenPast } from './overflow';
import { setGridFrame, useSuggestions } from './suggestions';

interface BoundaryProps {
  type: string;
  /** The component's code: a new version, such as a mod saved again, gets a fresh try. */
  version: unknown;
  children: ReactNode;
}

/** Keeps a component that throws while drawing inside its own tile, so it can't take the app down. */
class TileBoundary extends Component<BoundaryProps, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    reportTileError(this.props.type, error);
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.error !== null && previous.version !== this.props.version) this.setState({ error: null });
  }

  render() {
    return this.state.error !== null ? <div className="chart-message">This tile stopped: {this.state.error}</div> : this.props.children;
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
 * Holds a drawn component and says, with a faded edge and a quiet "more" mark, when it has content
 * below or to the right of what the tile shows, whatever the component does with its overflow. One mark
 * in the bottom right corner names both ways: "more ▾", "more ▸" or "more ▾▸".
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
  // Props from before an edit that the component's new args no longer accept: it draws with none.
  const props = useMemo(() => (definition && !Value.Check(definition.args, spec.props) ? {} : spec.props), [definition, spec.props]);
  useEffect(() => {
    if (scope == null) return;
    return () => tileLookAhead.forget(scope);
  }, [scope]);
  const allowed = useTileLookAhead((s) => scope != null && s.approved[scope] === true);
  const View = definition?.View;
  if (!View) return <>{fallback}</>;
  if (definition.looksAhead && !allowed) return scope != null ? <LookAheadWarning scope={scope} /> : null;
  return (
    <ViewFrame>
      <TileBoundary type={spec.type} version={View}>
        <View props={props} label={spec.label} />
      </TileBoundary>
    </ViewFrame>
  );
}

const onMove = (tile: string, rect: Rect) => layoutOps.move({ tile, rect });
const onSwap = (a: string, b: string) => layoutOps.swap({ a, b });
const onClose = (tile: string) => void layoutOps.close({ tile });

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
  const nodes = useLayout((s) => s.nodes);
  const audio = useLive((s) => s.audio);
  const muted = useLive((s) => s.volume === 0);
  const streams = useLive((s) => s.streams);
  // What each header's slots say. An approval outlives an edit that drops `looksAhead`, but the header
  // only says so while it applies.
  const states = useMemo(() => {
    const ahead = new Set(components.filter((c) => c.looksAhead).map((c) => c.name));
    const out: Record<string, TileState> = {};
    for (const t of allTiles({ nodes })) {
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
  }, [approved, components, nodes, audio, muted, streams, marks]);
  return (
    <>
      <Stage registry={registry} highlight={highlight} marks={marks} />
      <GridSurface onMove={onMove} onSwap={onSwap} onClose={onClose} states={states} />
      <DropPreview />
    </>
  );
}
