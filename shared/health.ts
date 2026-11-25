/**
 * How each place a component shows stands, and how that's said to the agents. The renderer keeps the
 * report (`live.health`), and the main process asks for it. See docs/BUILD_MODE.md.
 */
import { formatClock } from './clock';

/** A moment in the session: its clock, and the playhead in UTC ms, as in date columns. */
export interface Moment {
  clockSec: number;
  playheadMs: number | null;
}

export interface PlaceHealth {
  /** A tile's id, or a preview's scope in the strip. */
  scope: string;
  where: 'tile' | 'strip';
  /** The component's name. */
  type: string;
  label: string;
  /**
   * `drawn` means it didn't throw, not that it's right. `needs_props` and `error` aren't drawing.
   * `waiting` looks ahead, and isn't drawn until the viewer allows it; or, with a `message`, follows a
   * place in the running order that nobody holds yet, and draws once somebody does.
   */
  state: 'drawn' | 'needs_props' | 'error' | 'waiting';
  /** Required props it has no value for. */
  missing: string[];
  /** Props it was given that its args don't accept any more. It draws without them, if nothing is missing. */
  dropped: string[];
  /** Why, for `error`, for props that don't fit in a way the two lists can't say, and for a place nobody holds. */
  message: string | null;
  /** When it first stood this way, for a place that isn't drawing. Null otherwise, or with no session open. */
  since: Moment | null;
}

/** "a", "a and b", "a, b and c". */
export function list(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The places that aren't drawing and should be. One waiting for the viewer's leave isn't a problem. */
export const notDrawing = (places: PlaceHealth[]): PlaceHealth[] => places.filter((p) => p.state === 'needs_props' || p.state === 'error');

/** Tells one problem from another: the same place failing another way is a new one. */
export const problemKey = (p: PlaceHealth): string => [p.scope, p.type, p.state, p.missing.join(','), p.message ?? ''].join('|');

const named = (p: PlaceHealth) => (p.where === 'strip' ? `Draft ${p.type} in the strip` : `Tile ${p.scope} "${p.label}" (${p.type})`);

/** One place, as a line for the build agent: what it is, how it stands, and what would fix it. */
export function describePlace(p: PlaceHealth): string {
  if (p.state === 'drawn') return `${named(p)}: drawn${p.dropped.length ? `, without ${list(p.dropped)}, which it no longer accepts` : ''}.`;
  if (p.state === 'waiting') return p.message ? `${named(p)}: waiting: ${p.message}.` : `${named(p)}: waiting for the user to allow it to look ahead.`;
  if (p.state === 'error') return `${named(p)}: render error: ${p.message ?? 'unknown'}. Fix the code.`;
  const dropped = p.dropped.length ? ` It no longer accepts ${list(p.dropped)}.` : '';
  const why = p.missing.length ? `needs ${list(p.missing)}` : (p.message ?? "its props don't fit");
  const fix = p.where === 'strip' ? 'Call suggest_tiles with it and its props, or ask the user whose.' : 'Call edit_tile on it with them, or ask the user whose.';
  return `${named(p)}: ${why}.${dropped} ${fix}`;
}

/** What to tell the build agent before it ends a turn with something not drawing. */
export function renderCheckText(places: PlaceHealth[]): string {
  const lines = notDrawing(places).map((p) => `- ${describePlace(p)}`);
  return `Before you finish, these aren't drawing:\n${lines.join('\n')}\nFix what you can now. If one needs something only the user can say, ask them.`;
}

/** A tile that isn't drawing, as the viewer attaches it to a message: how it stood, and what it was drawn with. */
export interface ErrorReport {
  place: PlaceHealth;
  /** The tile's props. */
  props: Record<string, unknown>;
  /** The mod's log, where a render error's stack is, relative to the mods folder. Null for the app's own components. */
  log: string | null;
}

/** One report, as an agent reads it: a block of JSON before the viewer's words. See docs/HOST.md. */
export function errorBlock({ place, props, log }: ErrorReport): string {
  const fields = {
    tile: place.scope,
    label: place.label,
    type: place.type,
    state: place.state,
    message: place.message,
    ...(place.missing.length ? { missing: place.missing } : {}),
    ...(place.dropped.length ? { dropped: place.dropped } : {}),
    // A query or seek there shows the agent what the data held when it broke.
    ...(place.since ? { [place.state === 'error' ? 'first_threw' : 'since']: { clock: formatClock(place.since.clockSec), playhead: place.since.playheadMs } } : {}),
    props,
    ...(log ? { log } : {}),
  };
  return `<error>\n${JSON.stringify(fields, null, 2)}\n</error>`;
}

/**
 * A tile offered for a fix that has no error any more, or is gone, by the time the viewer switches to build mode, as
 * the build agent reads it in place of its error. `place` is how it stands now, or null for a tile that's gone.
 */
export function drawsAgainBlock(tile: string, place: PlaceHealth | null): string {
  const fields = place
    ? { tile, label: place.label, type: place.type, state: place.state, message: 'It has no error now. There may be nothing to fix.' }
    : { tile, state: 'gone', message: 'It is no longer on screen.' };
  return `<error>\n${JSON.stringify(fields, null, 2)}\n</error>`;
}
