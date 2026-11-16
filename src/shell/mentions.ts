/**
 * Mentions in the palette's prompt: `@` and a few letters pick a thing, such as a driver, and it stays in
 * the prompt as a tag. A tag is that thing, not the text typed to find it, so the agent reads it exactly.
 *
 * What can be mentioned is a list of kinds (src/shell/mentionKinds.tsx): the tiles on screen, drivers and
 * teams. Each kind searches what it has, draws its tag and says it as text for the agent. This file is the
 * part without the DOM: the types, each kind's search, finding the `@` being typed, and the prompt as text.
 */
import type { DriverEntry } from '../../shared/sessionData';
import { normalize } from '../agent/matching';

/** A thing in the prompt: which kind, and its id within the kind (a driver's car number as text, a team's name, a tile's id). */
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

/**
 * Where a bare `@` puts each kind, after the rows of the kinds before it. A typed query orders rows of
 * every kind by how well they match; a kind's order only breaks ties.
 */
const BARE = { tile: 4, driver: 5, team: 6 } as const;

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
    if (!q) rank = BARE.driver;
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

/** A query as search reads it: no accents or case, single spaces. */
const queryOf = (query: string): string => normalize(query).replace(/\s+/g, ' ');

/** How well words match a query, as `searchDrivers` ranks a name: a whole word or the whole text, else a start. */
function wordRank(text: string, q: string): number | null {
  const words = text.split(' ').filter(Boolean);
  if (words.includes(q) || text === q) return 1;
  if (words.some((w) => w.startsWith(q)) || text.startsWith(q)) return 3;
  return null;
}

/** A team: its name as the roster has it, its colour and its drivers by car number. */
export interface TeamEntry {
  name: string;
  colour: string | null;
  drivers: number[];
}

/** The roster's teams, in the order their first driver comes. */
export function teamsOf(drivers: readonly DriverEntry[]): TeamEntry[] {
  const teams = new Map<string, TeamEntry>();
  for (const d of drivers) {
    if (!d.team_name) continue;
    const team = teams.get(d.team_name) ?? { name: d.team_name, colour: d.team_colour, drivers: [] };
    team.drivers.push(d.driver_number);
    teams.set(d.team_name, team);
  }
  return [...teams.values()];
}

/** A team's name as its tag shows it: without "Racing", "F1 Team" or "Team" at the end. "Red Bull", "Haas". */
export function shortTeamName(name: string): string {
  const short = name.replace(/\s+(F1 Team|Racing|Team)$/i, '').trim();
  return short || name;
}

/**
 * The teams a query finds, best first, as picker rows. Matches a word of the team's name from its start,
 * ignoring case and accents: `@red` and `@bull` find Red Bull Racing. An empty query offers every team.
 * `code` gives a car's code, for the row's detail.
 */
export function searchTeams(teams: readonly TeamEntry[], query: string, code: (number: number) => string): MentionOption[] {
  const q = queryOf(query).replace(/^#/, '');
  const out: MentionOption[] = [];
  for (const team of teams) {
    const rank = q ? wordRank(normalize(team.name), q) : BARE.team;
    if (rank == null) continue;
    out.push({ kind: 'team', id: team.name, rank, detail: `${team.drivers.map(code).join(' · ')}  ${team.name}`.trim() });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** A team as the agent reads it: its name and its drivers, "team Ferrari (LEC #16, HAM #44)". */
export function sayTeam(name: string, drivers: readonly { code: string | null | undefined; number: number }[]): string {
  const cars = drivers.map((d) => (d.code && d.code !== String(d.number) ? `${d.code} #${d.number}` : `#${d.number}`));
  return cars.length ? `team ${name} (${cars.join(', ')})` : `team ${name}`;
}

/** A tile on screen as a mention searches it: its id, and its label as text, as its title bar reads. */
export interface TileEntry {
  id: string;
  label: string;
}

/**
 * The tiles on screen a query finds, as picker rows. Matches a word of the label from its start, so
 * `@gap` finds "Gap to leader" and `@ham` finds "Onboard HAM". An empty query offers every tile, in the
 * order they were added, with no detail: the picker heads them "On screen".
 */
export function searchTiles(tiles: readonly TileEntry[], query: string): MentionOption[] {
  const q = queryOf(query);
  const out: MentionOption[] = [];
  for (const tile of tiles) {
    const rank = q ? wordRank(normalize(tile.label), q) : BARE.tile;
    if (rank == null) continue;
    out.push({ kind: 'tile', id: tile.id, rank, detail: q ? 'on screen' : '' });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** A tile as the agent reads it: its label and id, and whether it has closed since. 'tile "Gap to leader" (tile-3)'. */
export function sayTile(id: string, label: string, onScreen: boolean): string {
  return `tile "${label}" (${id}${onScreen ? '' : ', closed'})`;
}

/** The prompt as text, each mention as its kind says it. */
export function promptText(parts: readonly PromptPart[], say: (mention: Mention) => string): string {
  return parts.map((p) => (typeof p === 'string' ? p : say(p))).join('');
}

/** A driver as the agent reads it: its code and car number, "HAM (#44)", so it's never mistaken. */
export function sayDriver(code: string | null | undefined, number: number): string {
  return code && code !== String(number) ? `${code} (#${number})` : `#${number}`;
}
