/**
 * The components tiles can show. The app registers its own once at start, and mods register theirs
 * on every save (src/host/mods.ts), so the host can build their specs and draw them without knowing any: the agent picks one from `live.components`, which is the
 * JSON-safe half of each definition.
 */
import Type, { type Static, type TObject } from 'typebox';
import Value from 'typebox/value';
import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { SessionInfo, SessionType } from '../../shared/api';
import type { Dataset } from '../../shared/sessionData';
import { allTiles, type ComponentSpec, type ContentFit, type SizeHint } from '../layout/model';
import { layout, useLayout } from '../layout/store';
import { labelText } from './drivers';
import { write } from './op';

/** A spec's key and label, and the drivers it names. */
export interface Labelled {
  key: string;
  label: string;
  drivers?: number[];
}

interface Declared {
  /** The spec's `type`. */
  name: string;
  /** A short human name, like "Video". */
  title: string;
  /** What the agent reads when deciding what to suggest. */
  description: string;
  /** Session types it applies to, as `SessionInfo.type` names them. Omitted means any, and empty means none: it is never offered. */
  sessions?: SessionType[];
  /** The session data it reads. Omitted means none. */
  needs?: Dataset[];
  /** It reads car telemetry, which only a replay has: it is never offered in a live session. */
  replayOnly?: boolean;
  /**
   * A size hint: `aspect` is the shape it reads best in, as width over height, and `min` the least room
   * its content reads in, in pixels, not counting the tile's title bar. Auto-layout puts it where its
   * shape suits and keeps it at its least size while it can.
   */
  size?: SizeHint;
  /** How its content draws, when it doesn't simply fill the tile: the tile is shrunk to it. See `ContentFit`. */
  fit?: ContentFit;
  /**
   * It reads or acts on what the viewer hasn't watched yet. The grid then covers each tile of it with
   * a warning, and doesn't draw the view until the viewer allows that tile. See docs/BUILD_MODE.md.
   */
  looksAhead?: boolean;
}

export interface ComponentDefinition extends Declared {
  /** The props, which must stay JSON-safe. */
  args: TObject;
  /**
   * The tile's unique key and title-bar label. With `drivers`, the label is the name alone and the host
   * adds the drivers' codes, drawn as codes in the title bar. May throw if the props name something that isn't there.
   */
  spec(props: Record<string, unknown>): Labelled;
  View: ComponentType<{ props: Record<string, unknown>; label: string }>;
}

/**
 * Where a component comes from. `installed`: it came with the app, and can't be changed; its source is in the
 * mods folder's `.installed`, to read or fork. `local`: a mod in the mods folder, to edit. See docs/MODS.md.
 */
export type ComponentOrigin = 'installed' | 'local';

/** What `live.components` holds: a definition without its code. */
export interface ComponentInfo {
  name: string;
  origin: ComponentOrigin;
  title: string;
  description: string;
  /** The props' schema, as plain JSON. */
  args: Record<string, unknown>;
  /** Null means any session type, and empty means none. */
  sessions: SessionType[] | null;
  needs: Dataset[];
  replayOnly: boolean;
  /** Its shape, and the least room it reads in, in pixels. */
  size: SizeHint | null;
  looksAhead: boolean;
}

/** Declares a component that tiles can show by name. */
export function defineComponent<S extends TObject>(
  definition: Declared & {
    args: S;
    spec(props: Static<S>): Labelled;
    View: ComponentType<{ props: Static<S>; label: string }>;
  },
): ComponentDefinition {
  return definition as unknown as ComponentDefinition;
}

const definitions = new Map<string, ComponentDefinition>();
const origins = new Map<string, ComponentOrigin>();

/**
 * A definition's size hint, checked. A mod written when `min` was a pair of grid cells still loads: its
 * shape is kept and its least size dropped, with a warning in its log.
 */
function sizeOf(c: ComponentDefinition): SizeHint | null {
  const size = c.size as { aspect?: unknown; min?: unknown } | undefined;
  if (!size || typeof size.aspect !== 'number' || !(size.aspect > 0)) return null;
  const min = size.min as { width?: unknown; height?: unknown } | undefined;
  if (min && !Array.isArray(min) && typeof min.width === 'number' && typeof min.height === 'number') {
    return { aspect: size.aspect, min: { width: Math.max(0, min.width), height: Math.max(0, min.height) } };
  }
  console.warn(`${c.name}: size.min must be { width, height } in pixels. Its least size is ignored.`);
  return { aspect: size.aspect, min: { width: 0, height: 0 } };
}

/** Replaced as a whole on each registration, so a `useLive` selector over it stays stable. */
export const useComponents = create<{ list: ComponentInfo[] }>(() => ({ list: [] }));

function infoOf(c: ComponentDefinition): ComponentInfo {
  return {
    name: c.name,
    origin: origins.get(c.name) ?? 'local',
    title: c.title,
    description: c.description,
    args: JSON.parse(JSON.stringify(c.args)),
    sessions: c.sessions ?? null,
    needs: c.needs ?? [],
    replayOnly: c.replayOnly === true,
    size: sizeOf(c),
    looksAhead: c.looksAhead === true,
  };
}

/** What a component is checked against: the open session's type and status. */
export type Occasion = Pick<SessionInfo, 'type' | 'status'>;

const sessionTypeName = (type: SessionType) => type.replace('-', ' ');

/**
 * Each limit a component declares, as a check against the open session: why it doesn't fit, or null.
 * A new limit is a field on `Declared` and one more check here; the agent's chart list and
 * `suggest_tiles` both go through `misfit`.
 */
const limits: ((c: ComponentInfo, on: Occasion) => string | null)[] = [
  (c, on) =>
    c.sessions && !c.sessions.includes(on.type)
      ? c.sessions.length
        ? `is for ${c.sessions.map(sessionTypeName).join(', ')} sessions, and this is ${sessionTypeName(on.type)}`
        : 'is for no session'
      : null,
  (c, on) => (c.replayOnly && on.status === 'live' ? 'works in replays only, and this session is live' : null),
];

/** Why a component doesn't fit the open session, as a phrase after its name, or null if it does. Nothing is ruled out with no session open. */
export function misfit(c: ComponentInfo, on: Occasion | null | undefined): string | null {
  if (!on) return null;
  for (const limit of limits) {
    const why = limit(c, on);
    if (why) return why;
  }
  return null;
}

/** The components that fit the open session: all of them with none open. */
export const fitting = (list: ComponentInfo[], on: Occasion | null | undefined): ComponentInfo[] => list.filter((c) => !misfit(c, on));

export const componentOps = {
  register: write(
    {
      description: 'Make components available to tiles. One with a name already registered replaces it.',
      args: Type.Object({
        components: Type.Unsafe<ComponentDefinition[]>({ type: 'array', description: 'Definitions from defineComponent' }),
        origin: Type.Optional(Type.Union([Type.Literal('installed'), Type.Literal('local')], { description: "Where they come from: 'local', a mod, unless said" })),
      }),
    },
    ({ components, origin = 'local' }) => {
      for (const c of components) {
        definitions.set(c.name, c);
        origins.set(c.name, origin);
      }
      useComponents.setState({ list: [...definitions.values()].map(infoOf) });
    },
  ),
  unregister: write(
    {
      description: 'Make components unavailable, and take their tiles off screen. Returns the names that were registered.',
      args: Type.Object({ names: Type.Array(Type.String()) }),
    },
    ({ names }) => {
      const gone = names.filter((name) => definitions.delete(name));
      for (const name of gone) origins.delete(name);
      if (!gone.length) return gone;
      const ids = allTiles(useLayout.getState())
        .filter((t) => gone.includes(t.component.type))
        .map((t) => t.id);
      for (const id of ids) layout.remove(id);
      useComponents.setState({ list: [...definitions.values()].map(infoOf) });
      return gone;
    },
  ),
};

/**
 * A spec for a component with no props, whether or not it can draw with none: for a place that shows
 * what the component needs. Null for an unknown type.
 */
export function bareSpec(type: string): ComponentSpec | null {
  const definition = definitions.get(type);
  if (!definition) return null;
  const size = sizeOf(definition);
  return { type, key: type, label: definition.title, props: {}, ...(size ? { size } : {}), ...(definition.fit ? { fit: definition.fit } : {}) };
}

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
  const size = sizeOf(definition);
  const { key, label, drivers } = definition.spec(props);
  const named = drivers?.length ? { label: labelText(label, drivers), title: { name: label, drivers } } : { label };
  return { type, key, ...named, props, ...(size ? { size } : {}), ...(definition.fit ? { fit: definition.fit } : {}) };
}
