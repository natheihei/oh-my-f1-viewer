/** The grid and the components in it. Mouse edits arrive as host writes, like any other change. */
import { useMemo, type ComponentType } from 'react';
import { GridSurface } from '../layout/GridSurface';
import type { ComponentSpec, Rect } from '../layout/model';
import { Stage, type TileComponent } from '../layout/Stage';
import { layoutOps } from './layoutOps';

export interface ComponentDefinition {
  name: string;
  View: ComponentType<{ props: Record<string, unknown>; label: string }>;
}

/** Declares a component that tiles can show by name. */
export function defineComponent<P extends Record<string, unknown>>(definition: {
  name: string;
  View: ComponentType<{ props: P; label: string }>;
}): ComponentDefinition {
  return definition as unknown as ComponentDefinition;
}

const onMove = (tile: string, rect: Rect) => layoutOps.move({ tile, rect });
const onSwap = (a: string, b: string) => layoutOps.swap({ a, b });
const onClose = (tile: string) => void layoutOps.close({ tile });

export function Grid({ components }: { components: ComponentDefinition[] }) {
  // A stable wrapper per component, because a new one would remount every tile.
  const registry = useMemo(
    () =>
      Object.fromEntries(
        components.map(({ name, View }): [string, TileComponent] => [
          name,
          ({ spec }: { spec: ComponentSpec }) => <View props={spec.props} label={spec.label} />,
        ]),
      ),
    [components],
  );
  return (
    <>
      <Stage registry={registry} />
      <GridSurface onMove={onMove} onSwap={onSwap} onClose={onClose} />
    </>
  );
}
