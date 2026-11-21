/**
 * Draws the layout tree with GridStack as transparent placeholders, and reports mouse edits back.
 * Placeholders hold no state, so a change simply rebuilds them without touching a video, because
 * components live in the Stage underneath.
 *
 * Only each tile's title bar and resize handles take the mouse. Everything else passes through to
 * the component underneath, so it can handle its own clicks. While Alt is held the whole tile takes it
 * instead, and drags as its title bar does.
 */
import { GridStack, type GridStackNode, type GridStackOptions } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { useEffect, useRef } from 'react';
import { GRID_COLUMNS, GRID_ROWS, type ComponentSpec, type Rect, type Tile } from './model';
import { layout, useLayout } from './store';

const GRIP = 'tile-grip';
/** On the grid while Alt alone is held: see styles.css. */
const ALT_DRAG = 'grid-alt-drag';

/**
 * What a tile's header says about it besides its label, in fixed slots on the right: which tile
 * carries the sound, whether its stream is catching up, and whether it may look ahead.
 */
export interface TileState {
  /** This tile's feed is the one heard: 'on' when audible, 'muted' when the volume is down. */
  audio?: 'on' | 'muted';
  /** A short word while the stream isn't playing cleanly, e.g. "sync". */
  status?: string;
  /** The status is a failure. */
  error?: boolean;
  /** The viewer let this tile read past the playhead. */
  ahead?: boolean;
  /** What build mode did to this tile's mod: "draft" or "edited". The tile is framed and its header lit, as a pointed one is. */
  mark?: string;
  /**
   * The spotlight: 'pointed' for the tile the viewer is pointing at, which is framed and its header lit,
   * and 'dimmed' for every other tile while one is. Neither when none is.
   */
  spot?: 'pointed' | 'dimmed';
}

const NO_STATES: Record<string, TileState> = {};

function signature(tiles: Tile[]): string {
  return JSON.stringify(tiles.map((t) => [t.id, t.x, t.y, t.w, t.h, t.component.label]));
}

/** Fills a header's state slots in place, so a change of audio or sync doesn't rebuild the grid. */
function applyState(bar: Element, state: TileState = {}): void {
  bar.classList.toggle('tile-titlebar-audio', state.audio != null);
  const item = bar.closest('.grid-stack-item');
  item?.classList.toggle('tile-pointed', state.spot === 'pointed');
  item?.classList.toggle('tile-marked', state.mark != null);
  item?.classList.toggle('tile-dimmed', state.spot === 'dimmed');
  const slot = (name: string, text: string | null, cls = '') => {
    const el = bar.querySelector<HTMLElement>(`:scope .tile-slot-${name}`);
    if (!el) return;
    el.textContent = text ?? '';
    el.hidden = text == null;
    el.className = `tile-slot tile-slot-${name} ${cls}`;
  };
  slot('status', state.status ?? null, state.error ? 'tile-slot-error' : '');
  slot('mark', state.mark ?? null);
  slot('ahead', state.ahead ? 'ahead' : null, 'tile-slot-warn');
  slot('audio', state.audio === 'on' ? 'aud' : state.audio === 'muted' ? 'mute' : null, state.audio === 'on' ? 'tile-slot-on' : '');
}

/**
 * A tile draws its seam on its right and bottom edges only, so neighbours share one hairline. One that
 * ends at the grid's last column or row draws none there: the frame around the grid is that edge.
 */
function markEdges(item: Element, rect: Rect): void {
  item.classList.toggle('tile-last-column', rect.x + rect.w >= GRID_COLUMNS);
  item.classList.toggle('tile-last-row', rect.y + rect.h >= GRID_ROWS);
}

const baseOptions: GridStackOptions = {
  margin: 0,
  animate: false,
  mode: 'float',
  acceptWidgets: false,
  // GridStack otherwise adds handles on mouseover, which an item that lets the mouse through never gets.
  // They stay invisible until hovered: see styles.css.
  alwaysShowResizeHandle: true,
  resizable: { handles: 'e,s,se,w,sw' },
};

/**
 * The tile's header: dragging it moves the tile, and its x closes it. One grammar for every tile:
 * label, state slots, close.
 */
function addTitleBar(item: Element, tile: Tile, onClose: (id: string) => void): void {
  const content = item.querySelector(':scope > .grid-stack-item-content');
  if (!content || content.querySelector(':scope > .tile-titlebar')) return;
  const bar = document.createElement('div');
  bar.className = `tile-titlebar ${GRIP}`;
  bar.dataset.tileId = tile.id;
  const title = document.createElement('span');
  title.className = 'tile-title';
  title.textContent = tile.component.label;
  const slots = document.createElement('span');
  slots.className = 'tile-slots';
  for (const name of ['status', 'mark', 'ahead', 'audio']) {
    const el = document.createElement('span');
    el.className = `tile-slot tile-slot-${name}`;
    el.hidden = true;
    slots.append(el);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tile-close';
  close.title = `Close ${tile.component.label}`;
  close.setAttribute('aria-label', close.title);
  close.textContent = '×';
  // Keep a press on the button from starting a drag.
  close.addEventListener('mousedown', (e) => e.stopPropagation());
  close.addEventListener('pointerdown', (e) => e.stopPropagation());
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    onClose(tile.id);
  });
  bar.append(title, slots, close);
  content.appendChild(bar);
}

export function GridSurface({
  onMove,
  onSwap,
  onClose,
  states = NO_STATES,
  drawTitle,
}: {
  onMove: (id: string, rect: Rect) => void;
  onSwap: (a: string, b: string) => void;
  onClose: (id: string) => void;
  /** What each tile's header slots show, by tile id. */
  states?: Record<string, TileState>;
  /** Fills a tile's title from its component; a new function redraws every title. Without it, the title is the label. */
  drawTitle?: (el: HTMLElement, component: ComponentSpec, tileId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<GridStack | null>(null);
  const renderedRef = useRef('');
  const rebuildingRef = useRef(false);
  const tiles = useLayout((s) => s.tiles);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const cellHeight = () => host.clientHeight / GRID_ROWS;
    const created = GridStack.init(
      { ...baseOptions, column: GRID_COLUMNS, row: GRID_ROWS, cellHeight: cellHeight() },
      host,
    );
    if (!created) return;
    const grid = created;
    gridRef.current = grid;

    grid.on('change', (_event: Event, items: GridStackNode[]) => {
      if (rebuildingRef.current) return;
      for (const item of items ?? []) {
        if (item.id == null) continue;
        onMove(String(item.id), { x: item.x ?? 0, y: item.y ?? 0, w: item.w ?? 1, h: item.h ?? 1 });
      }
      renderedRef.current = signature(layout.snapshot().tiles);
    });

    // Dropped on another tile: swap them. Deferred because the swap rebuilds the placeholders, which
    // can't happen inside GridStack's own drag handling.
    const pointer = { x: 0, y: 0 };
    // GridStack drags a tile by its content box, which only takes the mouse at the title bar. Holding Alt
    // makes the whole box take it. Ctrl+Alt is left out because that is AltGr on Windows. Mouse moves set
    // it too, since a key pressed while another window had the focus never arrives here.
    const trackAlt = (e: KeyboardEvent | MouseEvent) => {
      host.classList.toggle(ALT_DRAG, e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey);
    };
    const dropAlt = () => host.classList.remove(ALT_DRAG);
    const trackPointer = (e: PointerEvent | MouseEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      trackAlt(e);
    };
    window.addEventListener('mousemove', trackPointer, true);
    window.addEventListener('keydown', trackAlt, true);
    window.addEventListener('keyup', trackAlt, true);
    window.addEventListener('blur', dropAlt);
    grid.on('dragstop', (_event: Event, el: HTMLElement) => {
      // Placeholders let the mouse through, so hit-test their boxes rather than elementsFromPoint.
      const target = [...(el.parentElement?.children ?? [])].find((item) => {
        if (item === el || !item.classList.contains('grid-stack-item') || item.classList.contains('grid-stack-placeholder')) return false;
        const r = item.getBoundingClientRect();
        return pointer.x >= r.left && pointer.x < r.right && pointer.y >= r.top && pointer.y < r.bottom;
      });
      const idA = el.getAttribute('gs-id');
      const idB = target?.getAttribute('gs-id');
      if (idA && idB) setTimeout(() => onSwap(idA, idB), 0);
    });

    const applyCellHeights = () => {
      layout.measure({ w: host.clientWidth / GRID_COLUMNS, h: host.clientHeight / GRID_ROWS });
      grid.cellHeight(cellHeight());
    };
    const observer = new ResizeObserver(applyCellHeights);
    observer.observe(host);

    return () => {
      window.removeEventListener('mousemove', trackPointer, true);
      window.removeEventListener('keydown', trackAlt, true);
      window.removeEventListener('keyup', trackAlt, true);
      window.removeEventListener('blur', dropAlt);
      observer.disconnect();
      gridRef.current = null;
      grid.destroy(false);
    };
  }, []);

  useEffect(() => {
    const grid = gridRef.current;
    const host = hostRef.current;
    if (!grid || !host) return;
    const sig = signature(tiles);
    if (sig === renderedRef.current) return;
    renderedRef.current = sig;

    rebuildingRef.current = true;
    // The event flag must stay on: without it GridStack leaves the removed elements in the DOM.
    grid.removeAll(true, true);
    grid.batchUpdate();
    for (const tile of tiles) {
      const el = grid.addWidget({ id: tile.id, x: tile.x, y: tile.y, w: tile.w, h: tile.h });
      if (el) {
        markEdges(el, tile);
        addTitleBar(el, tile, onClose);
      }
    }
    grid.batchUpdate(false);
    rebuildingRef.current = false;
  }, [tiles]);

  // After any rebuild above, and whenever the drawer changes, such as when the roster loads.
  useEffect(() => {
    if (!drawTitle) return;
    const components = new Map(tiles.map((t) => [t.id, t.component]));
    hostRef.current?.querySelectorAll<HTMLElement>('.tile-titlebar[data-tile-id]').forEach((bar) => {
      const component = components.get(bar.dataset.tileId ?? '');
      const title = bar.querySelector<HTMLElement>(':scope > .tile-title');
      if (component && title) drawTitle(title, component, bar.dataset.tileId ?? '');
    });
  }, [tiles, drawTitle]);

  // Runs after any rebuild above, so fresh headers get their slots filled too.
  useEffect(() => {
    hostRef.current?.querySelectorAll<HTMLElement>('.tile-titlebar[data-tile-id]').forEach((bar) => applyState(bar, states[bar.dataset.tileId ?? '']));
  }, [tiles, states]);

  return <div ref={hostRef} className="grid-stack grid-surface" data-testid="grid-surface" />;
}
