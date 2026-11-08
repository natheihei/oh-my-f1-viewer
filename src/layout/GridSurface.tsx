/**
 * Draws the layout tree with GridStack as transparent placeholders, and reports mouse edits back.
 * Placeholders hold no state, so a change simply rebuilds them: GridStack re-parenting nodes when
 * nesting can't touch a video, because components live in the Stage underneath.
 */
import { GridStack, type GridStackNode, type GridStackOptions } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { useEffect, useRef } from 'react';
import { GRID_COLUMNS, GRID_ROWS, GROUP_COLUMNS, GROUP_ROWS, type LayoutNode, type Rect } from './model';
import { layout, useLayout } from './store';

const GROUP_TITLE_PX = 18;
const TOP_GRIP = 'grip-top';
const SUB_GRIP = 'grip-sub';

function signature(nodes: LayoutNode[]): string {
  return JSON.stringify(
    nodes.map((n) =>
      n.kind === 'tile'
        ? [n.id, n.x, n.y, n.w, n.h]
        : [n.id, n.x, n.y, n.w, n.h, n.title, n.children.map((c) => [c.id, c.x, c.y, c.w, c.h])],
    ),
  );
}

const baseOptions: GridStackOptions = {
  margin: 0,
  animate: false,
  mode: 'float',
  acceptWidgets: false,
  alwaysShowResizeHandle: false,
  resizable: { handles: 'e,s,se,w,sw' },
};

function addGrip(item: Element, className: string): void {
  const content = item.querySelector(':scope > .grid-stack-item-content');
  if (content && !content.querySelector(`:scope > .${className}`)) {
    const grip = document.createElement('div');
    grip.className = `tile-grip ${className}`;
    content.appendChild(grip);
  }
}

export function GridSurface({ onMove, onSwap }: { onMove: (id: string, rect: Rect) => void; onSwap: (a: string, b: string) => void }) {
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
      const target = document
        .elementsFromPoint(pointer.x, pointer.y)
        .map((hit) => hit.closest('.grid-stack-item'))
        .find((item) => item && item !== el && item.parentElement === el.parentElement);
      const idA = el.getAttribute('gs-id');
      const idB = target?.getAttribute('gs-id');
      if (idA && idB) setTimeout(() => onSwap(idA, idB), 0);
    });

    const applyCellHeights = () => {
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
        if (el) addGrip(el, TOP_GRIP);
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
          el.querySelectorAll('.grid-stack-nested > .grid-stack-item').forEach((child) => addGrip(child, SUB_GRIP));
        }
      }
    }
    grid.batchUpdate(false);
    rebuildingRef.current = false;
  }, [nodes]);

  return <div ref={hostRef} className="grid-stack grid-surface" data-testid="grid-surface" />;
}
