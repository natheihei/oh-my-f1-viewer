/** The grid and the components in it. Mouse edits arrive as host writes, like any other change. */
import { useMemo, type ReactNode } from 'react';
import { GridSurface } from '../layout/GridSurface';
import type { ComponentSpec, Rect } from '../layout/model';
import { GRID_COLUMNS, GRID_ROWS } from '../layout/model';
import { Stage, type TileComponent } from '../layout/Stage';
import { componentOf, useComponents } from './components';
import { layoutOps } from './layoutOps';
import { setGridFrame, useSuggestions } from './suggestions';

/** Draws a spec with its registered component, or `fallback` if none is registered under its type. */
export function ComponentView({ spec, fallback = null }: { spec: ComponentSpec; fallback?: ReactNode }) {
  const View = componentOf(spec.type)?.View;
  return View ? <View props={spec.props} label={spec.label} /> : <>{fallback}</>;
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

// One wrapper per component name for good, because a new one would remount every tile showing it.
const wrappers = new Map<string, TileComponent>();
function wrapperOf(name: string): TileComponent {
  let wrapper = wrappers.get(name);
  if (!wrapper) {
    wrapper = ({ spec }) => <ComponentView spec={spec} />;
    wrappers.set(name, wrapper);
  }
  return wrapper;
}

/** Every tile, each drawn with the registered component its spec names. */
export function Grid() {
  const components = useComponents((s) => s.list);
  const registry = useMemo(() => Object.fromEntries(components.map(({ name }) => [name, wrapperOf(name)])), [components]);
  const highlight = useSuggestions((s) => s.highlight);
  return (
    <>
      <Stage registry={registry} highlight={highlight} />
      <GridSurface onMove={onMove} onSwap={onSwap} onClose={onClose} />
      <DropPreview />
    </>
  );
}
