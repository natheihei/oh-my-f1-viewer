/**
 * How each place a component shows stands, and how that's said to the build agent. The renderer keeps
 * the report (`live.health`), and the main process asks for it. See docs/BUILD_MODE.md.
 */

export interface PlaceHealth {
  /** A tile's id, or a preview's scope in the strip. */
  scope: string;
  where: 'tile' | 'strip';
  /** The component's name. */
  type: string;
  label: string;
  /**
   * `drawn` means it didn't throw, not that it's right. `needs_props` and `error` aren't drawing.
   * `waiting` looks ahead, and isn't drawn until the viewer allows it.
   */
  state: 'drawn' | 'needs_props' | 'error' | 'waiting';
  /** Required props it has no value for. */
  missing: string[];
  /** Props it was given that its args don't accept any more. It draws without them, if nothing is missing. */
  dropped: string[];
  /** Why, for `error`, and for props that don't fit in a way the two lists can't say. */
  message: string | null;
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
  if (p.state === 'waiting') return `${named(p)}: waiting for the user to allow it to look ahead.`;
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
