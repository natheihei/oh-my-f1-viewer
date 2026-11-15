/**
 * What a component says about the tile it's drawn in, and what it keeps there. The host draws a tile's
 * title bar from its spec until the component says otherwise with `useTileHeader`: a component whose
 * content changes as the viewer uses it, such as a battle showing whichever fight was picked, names
 * what it shows itself. `useTileState` keeps a component's own state with its tile, so it outlives the
 * component being drawn again, as when a mod is saved.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

/** Where a component is drawn: a tile on the grid, or a preview in the suggestion strip. */
export interface TilePlace {
  /** The tile's id, or the preview's scope. */
  scope: string;
  where: 'tile' | 'strip';
}

export const TilePlaceContext = createContext<TilePlace | null>(null);

/** The tile or preview the calling component is drawn in, or null outside one. */
export const useTilePlace = (): TilePlace | null => useContext(TilePlaceContext);

/** What a component says its tile's title bar shows. Each field it leaves out comes from its spec, or stays empty. */
export interface TileHeader {
  /** The title's name, in place of the spec's label. With `drivers`, the name alone: the bar adds their codes. */
  label?: string;
  /** Car numbers, drawn as codes after the name. */
  drivers?: number[];
  /** While a stream isn't playing cleanly: loading, catching up after a seek, or failed. */
  status?: 'load' | 'sync' | 'error';
  /** The tile holds the video that's heard: 'on', or 'muted' while the volume is 0. */
  audio?: 'on' | 'muted';
}

const STATUSES = new Set(['load', 'sync', 'error']);
const AUDIO = new Set(['on', 'muted']);

/** A header with only the fields that are well formed, since a mod may pass anything. */
export function cleanHeader(header: unknown): TileHeader {
  const h = (header ?? {}) as Record<string, unknown>;
  const out: TileHeader = {};
  if (typeof h.label === 'string') out.label = h.label;
  if (Array.isArray(h.drivers)) out.drivers = h.drivers.filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  if (typeof h.status === 'string' && STATUSES.has(h.status)) out.status = h.status as TileHeader['status'];
  if (typeof h.audio === 'string' && AUDIO.has(h.audio)) out.audio = h.audio as TileHeader['audio'];
  return out;
}

/** Each place's header, by its scope. Replaced as a whole on each change, so selectors over it stay stable. */
export const useTileHeaders = create<{ headers: Record<string, TileHeader> }>(() => ({ headers: {} }));

function setHeader(scope: string, header: TileHeader | null): void {
  useTileHeaders.setState((s) => {
    if (header == null && !(scope in s.headers)) return s;
    const headers = { ...s.headers };
    if (header == null) delete headers[scope];
    else headers[scope] = header;
    return { headers };
  });
}

/**
 * Says what the tile's title bar shows, for as long as the component is drawn. Call it on every render
 * with what's true now: it only writes when the header changes. Outside a tile or preview it does nothing.
 */
export function useTileHeader(header: TileHeader): void {
  const scope = useTilePlace()?.scope ?? null;
  const signature = JSON.stringify(cleanHeader(header));
  useEffect(() => {
    if (scope != null) setHeader(scope, JSON.parse(signature) as TileHeader);
  }, [scope, signature]);
  useEffect(() => {
    if (scope == null) return;
    return () => setHeader(scope, null);
  }, [scope]);
}

const useTileStates = create<{ states: Record<string, Record<string, unknown>> }>(() => ({ states: {} }));
const NONE = Symbol('none');

/**
 * Like `useState`, but kept with the tile: a component drawn again, as when its mod is saved, gets
 * back what it had. Each key is one value. The tile's states go when the tile leaves the grid. Outside
 * a tile or preview it's plain `useState`.
 */
export function useTileState<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void] {
  const scope = useTilePlace()?.scope ?? null;
  const initialRef = useRef(initial);
  const [local, setLocal] = useState(initial);
  const stored = useTileStates((s) => {
    const own = scope != null ? s.states[scope] : undefined;
    return own && key in own ? own[key] : NONE;
  });
  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      if (scope == null) {
        setLocal(next);
        return;
      }
      useTileStates.setState((s) => {
        const own = s.states[scope] ?? {};
        const previous = (key in own ? own[key] : initialRef.current) as T;
        const value = typeof next === 'function' ? (next as (p: T) => T)(previous) : next;
        if (Object.is(value, previous) && key in own) return s;
        return { states: { ...s.states, [scope]: { ...own, [key]: value } } };
      });
    },
    [scope, key],
  );
  if (scope == null) return [local, set];
  return [stored === NONE ? initialRef.current : (stored as T), set];
}

/** Forgets what a place's component said and kept: the tile left the grid, or the preview the strip. */
export function forgetTile(scope: string): void {
  setHeader(scope, null);
  useTileStates.setState((s) => {
    if (!(scope in s.states)) return s;
    const states = { ...s.states };
    delete states[scope];
    return { states };
  });
}
