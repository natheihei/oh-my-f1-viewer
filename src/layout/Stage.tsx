/**
 * Where components actually live: a flat layer under the grid, one stable host per tile, keyed by
 * tile id. A tile moving anywhere, including into a group, only changes its host's position, so
 * its component is never remounted. Hosts follow their placeholders every animation frame, which
 * also covers mid-drag and mid-resize. A host sits below its tile's title bar, which the grid draws.
 */
import { useEffect, useMemo, useRef, type ComponentType } from 'react';
import { allTiles, TITLE_BAR_PX, type ComponentSpec } from './model';
import { useLayout } from './store';

export type TileComponent = ComponentType<{ spec: ComponentSpec; tileId: string }>;

const NO_MARKS: Record<string, string> = {};

/**
 * `highlight` outlines the tile with that component key. `marks` holds a word for some component types,
 * such as "edited": their tiles get a dashed outline. The word itself is a slot in the tile's header.
 */
export function Stage({
  registry,
  highlight = null,
  marks = NO_MARKS,
}: {
  registry: Record<string, TileComponent>;
  highlight?: string | null;
  marks?: Record<string, string>;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostsRef = useRef(new Map<string, HTMLDivElement>());
  const nodes = useLayout((s) => s.nodes);
  const tiles = useMemo(() => allTiles({ nodes }), [nodes]);

  useEffect(() => {
    let frame = 0;
    const last = new Map<string, string>();
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const root = rootRef.current;
      if (!root) return;
      const origin = root.getBoundingClientRect();
      for (const [id, host] of hostsRef.current) {
        const placeholder = document.querySelector(`.grid-stack-item[gs-id="${CSS.escape(id)}"]`);
        if (!placeholder) continue;
        const r = placeholder.getBoundingClientRect();
        const left = r.left - origin.left;
        const top = r.top - origin.top + TITLE_BAR_PX;
        const height = Math.max(0, r.height - TITLE_BAR_PX);
        const style = `${left}|${top}|${r.width}|${height}`;
        if (last.get(id) === style) continue;
        last.set(id, style);
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
        host.style.width = `${r.width}px`;
        host.style.height = `${height}px`;
        host.style.visibility = 'visible';
      }
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div ref={rootRef} className="stage" data-testid="stage">
      {tiles.map((tile) => {
        const Component = registry[tile.component.type];
        const mark = marks[tile.component.type];
        return (
          <div
            key={tile.id}
            data-tile={tile.id}
            data-tile-key={tile.component.key}
            data-tile-type={tile.component.type}
            data-tile-mark={mark}
            className={`stage-host ${tile.component.key === highlight ? 'stage-host-highlight' : ''} ${mark ? 'stage-host-marked' : ''}`}
            ref={(el) => {
              if (el) hostsRef.current.set(tile.id, el);
              else hostsRef.current.delete(tile.id);
            }}
          >
            {Component ? <Component spec={tile.component} tileId={tile.id} /> : null}
          </div>
        );
      })}
    </div>
  );
}
