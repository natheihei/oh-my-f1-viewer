/**
 * The components tiles can show. The app registers them once at start, so the host can build their
 * specs and draw them without knowing any: the agent picks one from `live.components`, which is the
 * JSON-safe half of each definition.
 */
import Type, { type Static, type TObject } from 'typebox';
import Value from 'typebox/value';
import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { SessionType } from '../../shared/api';
import type { Dataset } from '../../shared/sessionData';
import type { ComponentSpec } from '../layout/model';
import { write } from './op';

interface Declared {
  /** The spec's `type`. */
  name: string;
  /** A short human name, like "Video". */
  title: string;
  /** What the agent reads when deciding what to suggest. */
  description: string;
  /** Session types it applies to, as `SessionInfo.type` names them. Omitted means any. */
  sessions?: SessionType[];
  /** The session data it reads. Omitted means none. */
  needs?: Dataset[];
  /**
   * A size hint in grid cells: its shape, and the least room it reads in. Auto-layout shares a column by
   * the least height. `width` is the widest its content draws, in pixels: the tile is narrowed to it.
   */
  size?: { aspect: number; min: [number, number]; width?: number };
}

export interface ComponentDefinition extends Declared {
  /** The props, which must stay JSON-safe. */
  args: TObject;
  /** The tile's unique key and title-bar label. May throw if the props name something that isn't there. */
  spec(props: Record<string, unknown>): { key: string; label: string };
  View: ComponentType<{ props: Record<string, unknown>; label: string }>;
}

/** What `live.components` holds: a definition without its code. */
export interface ComponentInfo {
  name: string;
  title: string;
  description: string;
  /** The props' schema, as plain JSON. */
  args: Record<string, unknown>;
  /** Null means any session type. */
  sessions: SessionType[] | null;
  needs: Dataset[];
  size: { aspect: number; min: [number, number]; width?: number } | null;
}

/** Declares a component that tiles can show by name. */
export function defineComponent<S extends TObject>(
  definition: Declared & {
    args: S;
    spec(props: Static<S>): { key: string; label: string };
    View: ComponentType<{ props: Static<S>; label: string }>;
  },
): ComponentDefinition {
  return definition as unknown as ComponentDefinition;
}

const definitions = new Map<string, ComponentDefinition>();

/** Replaced as a whole on each registration, so a `useLive` selector over it stays stable. */
export const useComponents = create<{ list: ComponentInfo[] }>(() => ({ list: [] }));

function infoOf(c: ComponentDefinition): ComponentInfo {
  return {
    name: c.name,
    title: c.title,
    description: c.description,
    args: JSON.parse(JSON.stringify(c.args)),
    sessions: c.sessions ?? null,
    needs: c.needs ?? [],
    size: c.size ?? null,
  };
}

export const componentOps = {
  register: write(
    {
      description: 'Make components available to tiles. One with a name already registered replaces it.',
      args: Type.Object({
        components: Type.Unsafe<ComponentDefinition[]>({ type: 'array', description: 'Definitions from defineComponent' }),
      }),
    },
    ({ components }) => {
      for (const c of components) definitions.set(c.name, c);
      useComponents.setState({ list: [...definitions.values()].map(infoOf) });
    },
  ),
};

/** The registered definition for a spec's type, if there is one. */
export const componentOf = (type: string): ComponentDefinition | undefined => definitions.get(type);

/** A component and its props, as a caller names one. */
export const Item = Type.Object({
  type: Type.String({ description: 'A component name from live.components' }),
  props: Type.Record(Type.String(), Type.Unknown(), { description: "Props that match the component's args" }),
});

/** Builds the spec for a component and its props. Throws on an unknown type or props that don't fit. */
export function specOf({ type, props }: Static<typeof Item>): ComponentSpec {
  const definition = definitions.get(type);
  if (!definition) throw new Error(`Unknown component: ${type}`);
  if (!Value.Check(definition.args, props)) {
    const error = Value.Errors(definition.args, props)[0];
    throw new Error(`Invalid props for ${type}: ${error ? `${error.instancePath || '/'} ${error.message}` : 'they do not match its args'}`);
  }
  return { type, ...definition.spec(props), props, ...(definition.size ? { size: definition.size } : {}) };
}
