/**
 * Draws the layout tree with GridStack as transparent placeholders, and reports mouse edits back.
 * Placeholders hold no state, so a change simply rebuilds them: GridStack re-parenting nodes when
 * nesting can't touch a video, because components live in the Stage underneath.
 *
 * Only each tile's title bar and resize handles take the mouse. Everything else passes through to
 * the component underneath, so it can handle its own clicks.
 */
import { GridStack, type GridStackNode, type GridStackOptions } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { useEffect, useRef } from 'react';
import { GRID_COLUMNS, GRID_ROWS, GROUP_COLUMNS, GROUP_ROWS, type LayoutNode, type Rect, type TileNode } from './model';
import { layout, useLayout } from './store';

const GROUP_TITLE_PX = 18;
const TOP_GRIP = 'grip-top';
const SUB_GRIP = 'grip-sub';

function signature(nodes: LayoutNode[]): string {
  return JSON.stringify(
    nodes.map((n) =>
      n.kind === 'tile'
        ? [n.id, n.x, n.y, n.w, n.h, n.component.label]
        : [n.id, n.x, n.y, n.w, n.h, n.title, n.children.map((c) => [c.id, c.x, c.y, c.w, c.h, c.component.label])],
    ),
  );
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

/** The tile's title bar: dragging it moves the tile, and its x closes it. */
function addTitleBar(item: Element, className: string, tile: TileNode, onClose: (id: string) => void): void {
  const content = item.querySelector(':scope > .grid-stack-item-content');
  if (!content || content.querySelector(':scope > .tile-titlebar')) return;
  const bar = document.createElement('div');
  bar.className = `tile-titlebar tile-grip ${className}`;
  const title = document.createElement('span');
  title.className = 'tile-title';
  title.textContent = tile.component.label;
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
  bar.append(title, close);
  content.appendChild(bar);
}

export function GridSurface({
  onMove,
  onSwap,
  onClose,
}: {
  onMove: (id: string, rect: Rect) => void;
  onSwap: (a: string, b: string) => void;
  onClose: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<GridStack | null>(null);
  const renderedRef = useRef('');
  const rebuildingRef = useRef(false);
  const nodes = useLayout((s) => s.nodes);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const cellHeight = () => host.clientHeight / GRID_ROWS;
    const created = GridStack.init(
      { ...baseOptions, column: GRID_COLUMNS, row: GRID_ROWS, cellHeight: cellHeight(), handle: `.${TOP_GRIP}` },
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
      renderedRef.current = signature(layout.snapshot().nodes);
    });

    // Dropped on another tile: swap them. Deferred because the swap rebuilds the placeholders, which
    // can't happen inside GridStack's own drag handling.
    const pointer = { x: 0, y: 0 };
    const trackPointer = (e: PointerEvent | MouseEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    window.addEventListener('mousemove', trackPointer, true);
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
      layout.measure(host.clientWidth / GRID_COLUMNS);
      grid.cellHeight(cellHeight());
      for (const node of grid.engine.nodes) {
        const el = node.el;
        if (node.subGrid && el) {
          node.subGrid.cellHeight((el.clientHeight - GROUP_TITLE_PX) / GROUP_ROWS);
        }
      }
    };
    const observer = new ResizeObserver(applyCellHeights);
    observer.observe(host);

    return () => {
      window.removeEventListener('mousemove', trackPointer, true);
      observer.disconnect();
      gridRef.current = null;
      grid.destroy(false);
    };
  }, []);

  useEffect(() => {
    const grid = gridRef.current;
    const host = hostRef.current;
    if (!grid || !host) return;
    const sig = signature(nodes);
    if (sig === renderedRef.current) return;
    renderedRef.current = sig;

    rebuildingRef.current = true;
    // The event flag must stay on: without it GridStack leaves the removed elements in the DOM.
    grid.removeAll(true, true);
    grid.batchUpdate();
    const cell = host.clientHeight / GRID_ROWS;
    for (const node of nodes) {
      const rect = { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h };
      if (node.kind === 'tile') {
        const el = grid.addWidget(rect);
        if (el) addTitleBar(el, TOP_GRIP, node, onClose);
      } else {
        const el = grid.addWidget({
          ...rect,
          subGridOpts: {
            ...baseOptions,
            column: GROUP_COLUMNS,
            row: GROUP_ROWS,
            cellHeight: (node.h * cell - GROUP_TITLE_PX) / GROUP_ROWS,
            handle: `.${SUB_GRIP}`,
            class: 'tile-group-grid',
            children: node.children.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
          },
        });
        if (el) {
          const title = document.createElement('div');
          title.className = `group-title tile-grip ${TOP_GRIP}`;
          title.textContent = node.title;
          el.querySelector(':scope > .grid-stack-item-content')?.prepend(title);
          el.classList.add('tile-group');
          el.querySelectorAll('.grid-stack-nested > .grid-stack-item').forEach((child) => {
            const tile = node.children.find((c) => c.id === child.getAttribute('gs-id'));
            if (tile) addTitleBar(child, SUB_GRIP, tile, onClose);
          });
        }
      }
    }
    grid.batchUpdate(false);
    rebuildingRef.current = false;
  }, [nodes]);

  return <div ref={hostRef} className="grid-stack grid-surface" data-testid="grid-surface" />;
}
