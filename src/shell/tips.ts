/**
 * What the folded palette says while nothing is happening: one tip at a time, in place of its placeholder. A tip is
 * a fixed line about the app, never about the race, so the spoiler rules have nothing to check here.
 *
 * To add one, add a line to `TIPS`. In its text `[Key]` is a key cap, `[palette]` is the palette's shortcut as it's
 * set now, and a `/name` is a command. Keep it true of the app as it is, and short enough for the folded row.
 */

export interface Tip {
  /** Stable name, for tests and for telling two tips apart. */
  id: string;
  /** `[Key]` is a key cap, `[palette]` the palette's shortcut as set now, `/name` a command. */
  text: string;
}

export const TIPS: Tip[] = [
  // The palette
  { id: 'palette-key', text: '[palette] opens the palette, and hides it again' },
  { id: 'mention', text: 'Type [@] to point at a tile, a driver or a team' },
  { id: 'plain-words', text: 'Ask in plain words, like “onboard for LEC” or “tyre strategy”' },
  { id: 'place-suggestion', text: 'Drag a suggested tile out of the palette to place it yourself' },
  { id: 'rebind', text: 'Click [palette] in the open palette to change the shortcut' },
  { id: 'history-height', text: "Drag the open palette's top edge to see more of its history" },
  // Tiles
  { id: 'move-anywhere', text: 'Hold [Alt] and drag anywhere on a tile to move it' },
  { id: 'swap', text: 'Drop a tile on another to swap them' },
  { id: 'resize', text: "Drag a tile's edge to resize it" },
  { id: 'auto-layout', text: '/auto-layout tidies the grid after moves and resizes' },
  { id: 'background', text: '/settings-background fills the gaps between tiles' },
  // Playback
  { id: 'play-seek', text: '[Space] plays and pauses · [←] [→] skip 10 seconds' },
  { id: 'volume', text: '[↑] [↓] change the volume · [M] mutes' },
];

/** How long a tip stays, and the placeholder before the first one. Slow: the row sits over the race. */
export const TIP_MS = 20_000;

/** A tip's text in pieces: words, key caps and commands. */
export type TipPart = string | { key: string } | { command: string };

/** How this machine writes the keys a tip names. */
export interface TipKeys {
  /** The palette's shortcut as set now, such as Ctrl+K. */
  palette: string;
  mac: boolean;
}

/** A tip's text as pieces to draw, with each key written as this machine writes it. */
export function tipParts(text: string, keys: TipKeys): TipPart[] {
  const parts: TipPart[] = [];
  let at = 0;
  // A command is a / at the start of a word, so "and/or" isn't one.
  for (const m of text.matchAll(/\[([^\]]+)\]|(?<=^|\s)(\/[a-z][a-z0-9-]*)/g)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    if (m[2]) parts.push({ command: m[2] });
    else parts.push({ key: m[1] === 'palette' ? keys.palette : m[1] === 'Alt' && keys.mac ? '⌥' : m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** A tip as plain words, as it reads on screen. */
export function tipText(tip: Tip, keys: TipKeys): string {
  return tipParts(tip.text, keys)
    .map((p) => (typeof p === 'string' ? p : 'key' in p ? p.key : p.command))
    .join('');
}

/**
 * Deals the tips in a shuffled order, each once before any comes round again. Between two rounds it deals null
 * once, for the placeholder, and the next round never opens on the tip the last one closed on.
 */
export function createTipDeck(tips: Tip[] = TIPS, random: () => number = Math.random): () => Tip | null {
  let order: Tip[] = [];
  let at = 0;
  let last: Tip | null = null;
  const shuffle = () => {
    order = [...tips];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (order.length > 1 && order[0] === last) [order[0], order[1]] = [order[1], order[0]];
    at = 0;
  };
  return () => {
    if (tips.length === 0) return null;
    if (at >= order.length) {
      const dealt = order.length > 0;
      shuffle();
      if (dealt) return null;
    }
    last = order[at++];
    return last;
  };
}

/** The app's deck: one per run, so folding the palette again carries on where it left off. */
export const nextTip = createTipDeck();
