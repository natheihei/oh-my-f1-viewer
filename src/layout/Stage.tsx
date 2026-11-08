/**
 * Where components actually live: a flat layer under the grid, one stable host per tile, keyed by
 * tile id. A tile moving anywhere, including into a group, only changes its host's position, so
 * its component is never remounted. Hosts follow their placeholders every animation frame, which
 * also covers mid-drag and mid-resize.
 */
import { useEffect, useMemo, useRef, type ComponentType } from 'react';
import { allTiles, type ComponentSpec } from './model';
import { useLayout } from './store';

export type TileComponent = ComponentType<{ spec: ComponentSpec }>;

export function Stage({ registry }: { registry: Record<string, TileComponent> }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostsRef = useRef(new Map<string, HTMLDivElement>());
  const nodes = useLayout((s) => s.nodes);
  const tiles = useMemo(() => allTiles({ nodes, primaryId: null, manual: false }), [nodes]);

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
        const style = `${r.left - origin.left}|${r.top - origin.top}|${r.width}|${r.height}`;
        if (last.get(id) === style) continue;
        last.set(id, style);
        host.style.left = `${r.left - origin.left}px`;
        host.style.top = `${r.top - origin.top}px`;
        host.style.width = `${r.width}px`;
        host.style.height = `${r.height}px`;
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
        return (
          <div
            key={tile.id}
            data-tile={tile.id}
            data-tile-key={tile.component.key}
            className="stage-host"
            ref={(el) => {
              if (el) hostsRef.current.set(tile.id, el);
              else hostsRef.current.delete(tile.id);
            }}
          >
            {Component ? <Component spec={tile.component} /> : null}
          </div>
        );
      })}
    </div>
  );
}
