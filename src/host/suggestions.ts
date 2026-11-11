/**
 * Tiles the agent suggests, waiting in a strip for the user to add, drag in or dismiss. The agent
 * can't put anything on screen itself: this is its only way to offer it.
 *
 * Suggestions belong to one turn. More in the same turn join the strip, skipping any already in it
 * or already added from it, and the next message clears it. What the user did with them goes back
 * to the agent with that message.
 */
import Type from 'typebox';
import { create } from 'zustand';
import { useSession } from '../data/session';
import { allTiles, findTile, GRID_COLUMNS, GRID_ROWS, dropTarget, type Cell, type ComponentSpec, type Rect } from '../layout/model';
import { layout, useLayout } from '../layout/store';
import { useBuild } from './build';
import { componentOf, Item, specOf, useComponents } from './components';
import { previewScope, tileLookAhead } from './lookAhead';
import { write } from './op';

/** Each suggested stream is a live preview, and so a real stream from the CDN. */
export const MAX_SUGGESTED_STREAMS = 4;

export interface SuggestionsView {
  items: ComponentSpec[];
  /** The key of the tile to outline in the layout: the suggestion under the mouse is already on screen. */
  highlight: string | null;
  /** Where a suggestion being dragged would land, in grid cells. */
  drop: Rect | null;
}

export const useSuggestions = create<SuggestionsView>(() => ({ items: [], highlight: null, drop: null }));

/** What happened to this turn's suggestions, for the agent's next message. */
let added: string[] = [];
let dismissed: string[] = [];
/** Keys added from the strip this turn, so suggesting them again doesn't bring them back. */
let taken = new Set<string>();
/** The user dismissed the strip: nothing joins it until the next turn. */
let closed = false;

/**
 * Build mode's drafts: the keys of the previews the app put in the strip itself, one for each mod the
 * build added or changed that has no tile on screen. They outlast a turn, unlike what the agent suggests.
 */
let drafts = new Set<string>();
/** The props the agent suggested a draft with, by component name, such as the drivers the viewer named. */
const draftProps = new Map<string, Record<string, unknown>>();

/** Whether a component is a mod the build under way added or changed. */
const isDraft = (type: string) => {
  const { active, changes } = useBuild.getState();
  return active && changes.some((c) => c.name === type && c.change !== 'deleted');
};

let frame: HTMLElement | null = null;

/** The grid's box on screen, for turning a pointer position into a cell. Set by the grid. */
export function setGridFrame(el: HTMLElement | null): void {
  frame = el;
}

/** The grid cell under a pointer, and a cell's width over its height, or null off the grid. */
function cellAt(clientX: number, clientY: number): { cell: Cell; aspect: number } | null {
  const box = frame?.getBoundingClientRect();
  if (!box || box.width === 0 || box.height === 0) return null;
  const fx = (clientX - box.left) / box.width;
  const fy = (clientY - box.top) / box.height;
  if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return null;
  return {
    cell: { x: Math.floor(fx * GRID_COLUMNS), y: Math.floor(fy * GRID_ROWS) },
    aspect: box.width / GRID_COLUMNS / (box.height / GRID_ROWS),
  };
}

const itemOf = (key: string) => useSuggestions.getState().items.find((s) => s.key === key);
const onScreen = (key: string) => findTile(useLayout.getState(), key) != null;

/** A new tile took over from a preview in the strip: what the viewer allowed the preview, the tile keeps. */
function carryApproval(key: string): void {
  const found = findTile(useLayout.getState(), key);
  if (found) tileLookAhead.move(previewScope(key), found.tile.id);
}

/** A draft's spec: with the props the agent suggested it with if they still fit, else with none. Null if neither draws. */
function draftSpec(name: string): ComponentSpec | null {
  for (const props of [draftProps.get(name), {}]) {
    if (!props) continue;
    try {
      return specOf({ type: name, props });
    } catch {
      // These props don't fit its args, or it can't draw without any.
    }
  }
  return null;
}

/**
 * Brings the strip's drafts in line with the build: a preview for each mod it added or changed that
 * isn't on screen, with no props unless the agent suggested it with some.
 */
function syncDrafts(): void {
  const { active, changes } = useBuild.getState();
  if (!active) draftProps.clear();
  const tiles = allTiles(useLayout.getState());
  const current = useSuggestions.getState().items;
  const others = current.filter((i) => !drafts.has(i.key));
  const wanted: ComponentSpec[] = [];
  if (active && !closed) {
    for (const { name, change } of changes) {
      if (change === 'deleted' || !componentOf(name)) continue;
      if (tiles.some((t) => t.component.type === name) || others.some((i) => i.type === name)) continue;
      const spec = draftSpec(name);
      if (spec) wanted.push(spec);
    }
  }
  const next = [...others.filter((i) => !wanted.some((w) => w.key === i.key)), ...wanted];
  drafts = new Set(wanted.map((w) => w.key));
  if (JSON.stringify(next) !== JSON.stringify(current)) useSuggestions.setState({ items: next });
}

/** Takes a suggestion out of the strip once it's been answered. */
function settleItem(spec: ComponentSpec): void {
  taken.add(spec.key);
  useSuggestions.setState((s) => ({
    items: s.items.filter((i) => i.key !== spec.key),
    highlight: s.highlight === spec.key ? null : s.highlight,
    drop: null,
  }));
}

const Key = Type.String({ description: 'The key of a suggested component' });
const Point = { key: Key, x: Type.Number({ description: 'Client x in pixels' }), y: Type.Number({ description: 'Client y in pixels' }) };

export const suggestionOps = {
  offer: write(
    {
      description: `Suggest components as tiles, for the user to add. Joins what's already suggested this turn, up to ${MAX_SUGGESTED_STREAMS} video streams.`,
      args: Type.Object({ items: Type.Array(Item) }),
    },
    ({ items: offered }) => {
      const result = { suggested: [] as string[], onScreen: [] as string[], repeated: [] as string[], overLimit: [] as string[] };
      if (closed) throw new Error('The user dismissed the suggestions this turn.');
      const items = [...useSuggestions.getState().items];
      for (const spec of offered.map(specOf)) {
        // A mod of this build suggested with props: its draft previews with them from here on.
        if (isDraft(spec.type)) {
          draftProps.set(spec.type, spec.props);
          (allTiles(useLayout.getState()).some((t) => t.component.type === spec.type) ? result.onScreen : result.suggested).push(spec.label);
          continue;
        }
        if (taken.has(spec.key) || items.some((i) => i.key === spec.key)) {
          result.repeated.push(spec.label);
          continue;
        }
        // Only streams count: each previewed one is a real stream from the CDN.
        if (spec.type === 'video' && items.filter((i) => i.type === 'video').length >= MAX_SUGGESTED_STREAMS) {
          result.overLimit.push(spec.label);
          continue;
        }
        items.push(spec);
        (onScreen(spec.key) ? result.onScreen : result.suggested).push(spec.label);
      }
      useSuggestions.setState({ items });
      syncDrafts();
      return result;
    },
  ),
  add: write(
    {
      description: "Add a suggestion to the layout, where auto-layout puts it, and take it out of the strip. One that's already on screen only leaves the strip.",
      args: Type.Object({ key: Key }),
    },
    ({ key }) => {
      const spec = itemOf(key);
      if (!spec) return false;
      // The layout first: a preview hands its stream to the new tile rather than stopping it.
      if (!onScreen(key)) {
        layout.add(spec);
        carryApproval(key);
        added.push(spec.label);
      }
      settleItem(spec);
      return true;
    },
  ),
  dragOver: write(
    { description: 'Show where a suggestion being dragged would land.', args: Type.Object(Point) },
    ({ key, x, y }) => {
      const at = cellAt(x, y);
      const target = at && itemOf(key) && !onScreen(key) ? dropTarget(useLayout.getState(), at.cell, at.aspect) : null;
      const drop = target?.rect ?? null;
      const current = useSuggestions.getState().drop;
      if (JSON.stringify(drop) !== JSON.stringify(current)) useSuggestions.setState({ drop });
    },
  ),
  drop: write(
    {
      description: 'Drop a suggestion on the grid: it splits the tile under the pointer, or fills the gap there. Returns whether it landed.',
      args: Type.Object(Point),
    },
    ({ key, x, y }) => {
      useSuggestions.setState({ drop: null });
      const spec = itemOf(key);
      const at = cellAt(x, y);
      if (!spec || !at || onScreen(key)) return false;
      layout.addAt(spec, at.cell, at.aspect);
      carryApproval(key);
      added.push(spec.label);
      settleItem(spec);
      return true;
    },
  ),
  cancelDrag: write({ description: 'Stop showing where a drag would land.' }, () => useSuggestions.setState({ drop: null })),
  highlight: write(
    {
      description: 'Outline the tile in the layout a suggestion duplicates, or nothing.',
      args: Type.Object({ key: Type.Union([Key, Type.Null()]) }),
    },
    ({ key }) => {
      const highlight = key != null && onScreen(key) ? key : null;
      if (useSuggestions.getState().highlight !== highlight) useSuggestions.setState({ highlight });
    },
  ),
  dismiss: write({ description: "Dismiss the whole strip. Nothing joins it again until the user's next message." }, () => {
    dismissed.push(...useSuggestions.getState().items.map((i) => i.label));
    closed = true;
    useSuggestions.setState({ items: [], highlight: null, drop: null });
  }),
  /**
   * Starts a new turn: clears the strip, and returns what the user did with the last one, for the
   * agent, or null if there was nothing to tell.
   */
  newTurn: write({ description: 'Clear the strip for a new turn. Returns what became of the suggestions, for the agent.' }, () => {
    const ignored = useSuggestions.getState().items.map((i) => i.label);
    const parts = [
      added.length ? `added ${added.join(', ')}` : '',
      dismissed.length ? `dismissed ${dismissed.join(', ')}` : '',
      ignored.length ? `left ${ignored.join(', ')} unanswered` : '',
    ].filter(Boolean);
    clearSuggestions();
    return parts.length ? `From your last suggestions the user ${parts.join('; ')}.` : null;
  }),
};

/** Forgets every suggestion, as opening or closing a session does. */
export function clearSuggestions(): void {
  added = [];
  dismissed = [];
  taken = new Set();
  closed = false;
  drafts = new Set();
  useSuggestions.setState({ items: [], highlight: null, drop: null });
  syncDrafts();
}

// A suggestion only makes sense for the session it was made in.
useSession.subscribe((state, prev) => {
  if (state.session !== prev.session) clearSuggestions();
});

// Drafts follow the build, what's registered and what's on screen.
useBuild.subscribe(syncDrafts);
useComponents.subscribe(syncDrafts);
useLayout.subscribe(syncDrafts);
