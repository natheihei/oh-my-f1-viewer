/** The grid and the components in it. Mouse edits arrive as host writes, like any other change. */
import { Component, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { GridSurface, type TileState } from '../layout/GridSurface';
import type { ComponentSpec, Rect } from '../layout/model';
import { GRID_COLUMNS, GRID_ROWS } from '../layout/model';
import { useLayout } from '../layout/store';
import { Stage, type TileComponent } from '../layout/Stage';
import { useBuild } from './build';
import { fillTitle, labelText, useDriverStyles } from './drivers';
import { componentOf, useComponents } from './components';
import { fitProps, health, healthOps, type PlaceHealth } from './health';
import { layoutOps, usePointed } from './layoutOps';
import { previewScope, tileLookAhead, useTileLookAhead } from './lookAhead';
import { reportTileError } from './mods';
import { useHiddenPast } from './overflow';
import { followsPlaces, resolvePlaces, usePlaces, useRunningOrder, type Place as RunningPlace } from './places';
import { setGridFrame, useSuggestions } from './suggestions';
import { forgetTile, TilePlaceContext, useTileHeaders, type TilePlace, type TileHeader } from './tile';

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

/** Why a tile following a place has nothing to draw yet. */
function waitingText(waiting: readonly RunningPlace[], order: readonly number[]): string {
  return order.length ? `Nobody is in ${waiting.join(' or ')}` : `Waiting for the running order, to find ${waiting.join(' and ')}`;
}

/**
 * Whether a component can't be drawn with these props, such as two places held by one car in a chart
 * of two drivers: its spec's reason, or null. Only asked of props that follow a place, whose cars change.
 */
function specProblem(definition: NonNullable<ReturnType<typeof componentOf>>, props: Record<string, unknown>): string | null {
  try {
    definition.spec(props);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Draws a spec with its registered component, or `fallback` if none is registered under its type.
 * `scope` names the tile or preview it draws in, which is what a look-ahead approval belongs to. A
 * component that declares `looksAhead` isn't drawn there until the viewer allows it. A driver prop that
 * holds a place, such as "P1", reaches the component as the car in that place at the playhead: see `places.ts`.
 */
export function ComponentView({ spec, scope = null, fallback = null }: { spec: ComponentSpec; scope?: string | null; fallback?: ReactNode }) {
  // Re-renders when a mod's component is replaced, wherever this is drawn.
  useComponents((s) => s.list);
  const definition = componentOf(spec.type);
  const follows = useMemo(() => followsPlaces(spec.props), [spec.props]);
  const order = useRunningOrder(follows);
  const placed = useMemo(() => resolvePlaces(spec.props, order), [spec.props, order]);
  const waiting = placed.waiting.length ? waitingText(placed.waiting, order) : null;
  // Props from before an edit may not fit the component's new args: it keeps those that do.
  const fit = useMemo(() => (definition ? fitProps(definition.args, placed.props) : null), [definition, placed.props]);
  const unfit = useMemo(() => (follows && definition && !waiting && !fit?.message ? specProblem(definition, fit!.props) : null), [follows, definition, waiting, fit]);
  useEffect(() => {
    if (scope == null) return;
    return () => {
      tileLookAhead.forget(scope);
      health.forget(scope);
      forgetTile(scope);
    };
  }, [scope]);
  const allowed = useTileLookAhead((s) => scope != null && s.approved[scope] === true);
  const View = definition?.View;
  const place = useMemo<Place | null>(
    () => (scope != null ? { scope, where: scope === previewScope(spec.key) ? 'strip' : 'tile', type: spec.type, label: spec.label } : null),
    [scope, spec.key, spec.type, spec.label],
  );
  const tilePlace = useMemo<TilePlace | null>(() => (place ? { scope: place.scope, where: place.where } : null), [place]);
  const lookingAhead = !!View && !fit?.message && definition?.looksAhead === true && !allowed;
  // Nobody in its place yet is no fault: the tile says so, and draws once somebody is.
  const empty = waiting ?? unfit;
  // What isn't drawn reports here. What is, reports from its boundary, once it has drawn or thrown.
  useEffect(() => {
    if (!place || !View || !fit) return;
    if (empty) health.report({ ...place, state: 'waiting', missing: [], dropped: fit.dropped, message: empty }, View);
    else if (fit.message) health.report({ ...place, state: 'needs_props', missing: fit.missing, dropped: fit.dropped, message: fit.message }, View);
    else if (lookingAhead) health.report({ ...place, state: 'waiting', missing: [], dropped: fit.dropped, message: null }, View);
  }, [place, View, fit, lookingAhead, empty]);
  useEffect(() => {
    if (place && !View) health.forget(place.scope);
  }, [place, View]);
  if (!View || !fit) return <>{fallback}</>;
  if (empty) return <div className="chart-message">{empty}</div>;
  if (fit.message) return <TileProblem place={place} state="needs_props" text={fit.message} />;
  if (lookingAhead) return scope != null ? <LookAheadWarning scope={scope} /> : null;
  return (
    <ViewFrame>
      <TileBoundary type={spec.type} version={View} place={place} dropped={fit.dropped}>
        <TilePlaceContext.Provider value={tilePlace}>
          <View props={fit.props} label={spec.label} />
        </TilePlaceContext.Provider>
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

/** The part of a spec's title that a component's header replaces: its label, or its name and drivers. */
function titleOf(header: TileHeader): Partial<Pick<ComponentSpec, 'label' | 'title'>> {
  if (header.drivers) return { label: labelText(header.label ?? '', header.drivers), title: { name: header.label ?? '', drivers: header.drivers } };
  if (header.label != null) return { label: header.label, title: undefined };
  return {};
}

/** What a tile's title bar shows: its spec's label and drivers, as its component's header overrides them. */
export function tileTitle(spec: ComponentSpec, header: TileHeader | undefined): Pick<ComponentSpec, 'label' | 'title'> {
  return { label: spec.label, title: spec.title, ...(header ? titleOf(header) : {}) };
}

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
  // The spotlight: a suggestion under the mouse puts it on the tile it duplicates; pointing from the prompt, on that tile.
  const suggested = useSuggestions((s) => s.highlight);
  const pointed = usePointed((s) => s.tile);
  const building = useBuild((s) => s.active);
  const changes = useBuild((s) => s.changes);
  // What build mode changed, by component name: a new mod's tile is a draft, a changed one is edited.
  const marks = useMemo(
    () => (building ? Object.fromEntries(changes.filter((c) => c.change !== 'deleted').map((c) => [c.name, c.change === 'added' ? 'draft' : 'edited'])) : NO_MARKS),
    [building, changes],
  );
  const approved = useTileLookAhead((s) => s.approved);
  const tiles = useLayout((s) => s.tiles);
  const spotlit = (suggested != null ? tiles.find((t) => t.component.key === suggested)?.id : pointed) ?? null;
  const headers = useTileHeaders((s) => s.headers);
  // What each header's slots say: the stream slots are the component's to say, through useTileHeader.
  // An approval outlives an edit that drops `looksAhead`, but the header only says so while it applies.
  const states = useMemo(() => {
    const ahead = new Set(components.filter((c) => c.looksAhead).map((c) => c.name));
    const out: Record<string, TileState> = {};
    for (const t of tiles) {
      const state: TileState = {};
      if (approved[t.id] && ahead.has(t.component.type)) state.ahead = true;
      if (marks[t.component.type]) state.mark = marks[t.component.type];
      if (spotlit) state.spot = t.id === spotlit ? 'pointed' : 'dimmed';
      const header = headers[t.id];
      if (header?.audio) state.audio = header.audio;
      if (header?.status) {
        state.status = header.status;
        if (header.status === 'error') state.error = true;
      }
      out[t.id] = state;
    }
    return out;
  }, [approved, components, tiles, headers, marks, spotlit]);
  // Titles draw their drivers' codes from the roster, so they're drawn again when it changes, and a
  // place's holder from the running order, which each tile following one keeps current.
  const styles = useDriverStyles();
  const order = usePlaces((s) => s.order);
  const titles = useMemo(() => Object.fromEntries(Object.entries(headers).map(([id, h]) => [id, titleOf(h)])), [headers]);
  const drawTitle = useCallback(
    (el: HTMLElement, component: ComponentSpec, tileId: string) => fillTitle(el, { ...component, ...titles[tileId] }, styles, order),
    [styles, titles, order],
  );
  return (
    <>
      <Stage registry={registry} marks={marks} />
      <GridSurface onMove={onMove} onSwap={onSwap} onClose={onClose} states={states} drawTitle={drawTitle} />
      <DropPreview />
    </>
  );
}
