/**
 * Mentions in the palette's prompt: `@` and a few letters pick a thing, such as a driver, and it stays in
 * the prompt as a tag. A tag is that thing, not the text typed to find it, so the agent reads it exactly.
 *
 * What can be mentioned is a list of kinds (src/shell/mentionKinds.ts). Each kind searches what it has,
 * draws its tag and says it as text for the agent. Drivers are the first; teams, feeds or tiles are each
 * one more kind. This file is the part without the DOM: the types, the search for drivers, finding the
 * `@` being typed, and the prompt as text.
 */
import type { DriverEntry } from '../../shared/sessionData';
import { normalize } from '../agent/matching';

/** A thing in the prompt: which kind, and its id within the kind (a driver's car number, as text). */
export interface Mention {
  kind: string;
  id: string;
}

/** The prompt: text, with mentions among it. */
export type PromptPart = string | Mention;

/** One row of the picker. */
export interface MentionOption extends Mention {
  /** What the row says after the tag, such as "Lewis Hamilton  #44". */
  detail: string;
  /** Lower is a better match. Rows of every kind are ordered by it together. */
  rank: number;
}

/** A query longer than this is prose that happens to follow an `@`, not a search. */
const MAX_QUERY = 30;

/**
 * The `@` being typed: the text from an `@` that starts a word up to the caret, given the text before
 * the caret. A query can hold spaces ("@lewis ham"); whether it still finds anything decides if the
 * picker stays. Null when the caret isn't in a mention.
 */
export function mentionQuery(before: string): { query: string; start: number } | null {
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'/]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  return { query, start: at };
}

const fullName = (d: DriverEntry): string =>
  d.first_name && d.last_name ? `${d.first_name} ${d.last_name}` : (d.full_name ?? d.broadcast_name ?? '');

/**
 * The drivers a query finds, best first, as picker rows. Matches a car number (`44`, `#44`), a code
 * (`ham`), a first name, a surname or the full name, each from its start, ignoring case and accents.
 * An empty query offers the whole roster. A number only finds numbers, so `@1` lists 1, 10, 12, 14...
 */
export function searchDrivers(drivers: readonly DriverEntry[], query: string): MentionOption[] {
  const q = normalize(query).replace(/^#/, '').replace(/\s+/g, ' ');
  const out: MentionOption[] = [];
  for (const d of drivers) {
    const number = String(d.driver_number);
    const code = normalize(d.name_acronym ?? '');
    const name = normalize(fullName(d));
    const words = name.split(' ').filter(Boolean);
    let rank: number | null = null;
    if (!q) rank = 5;
    else if (/^\d+$/.test(q)) rank = number === q ? 0 : number.startsWith(q) ? 2 : null;
    else if (code === q) rank = 0;
    else if (words.includes(q) || name === q) rank = 1;
    else if (code.startsWith(q)) rank = 2;
    else if (words.some((w) => w.startsWith(q)) || name.startsWith(q)) rank = 3;
    if (rank == null) continue;
    out.push({ kind: 'driver', id: number, rank, detail: `${fullName(d)}  #${number}`.trim() });
  }
  return out.sort((a, b) => a.rank - b.rank || Number(a.id) - Number(b.id));
}

/** The prompt as text, each mention as its kind says it. */
export function promptText(parts: readonly PromptPart[], say: (mention: Mention) => string): string {
  return parts.map((p) => (typeof p === 'string' ? p : say(p))).join('');
}

/** A driver as the agent reads it: its code and car number, "HAM (#44)", so it's never mistaken. */
export function sayDriver(code: string | null | undefined, number: number): string {
  return code && code !== String(number) ? `${code} (#${number})` : `#${number}`;
}
