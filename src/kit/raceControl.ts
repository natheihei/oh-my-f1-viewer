/**
 * Reading race control's messages. The feed fills its structured columns only for flags: a sector's
 * yellow has `scope` and `sector`, a blue or black and white flag has `driver_number`, a safety car has
 * `category` SafetyCar. Deleted laps, the stewards' cases, penalties, the red flag and the restart order
 * come as plain text, so what they say is read from F1's wording here. A message no pattern knows is
 * shown as sent, with only clock times taken out and its cars drawn as drivers.
 */
import type { Part } from '../host';
import { num } from './values';

/** What a message's flag mark shows. `double` is a double yellow; `scEnd` and `vscEnd` a safety car or VSC ending. */
export type Signal =
  | 'green'
  | 'yellow'
  | 'double'
  | 'red'
  | 'blue'
  | 'blackwhite'
  | 'black'
  | 'chequered'
  | 'sc'
  | 'vsc'
  | 'scEnd'
  | 'vscEnd'
  | 'note';

/** The track as a whole: racing, or held under a red flag, a safety car or a VSC. */
export type Track = 'green' | 'red' | 'sc' | 'vsc' | 'scEnd' | 'vscEnd';

const text = (r: Record<string, unknown>): string => (typeof r.message === 'string' ? r.message : '');
const upper = (v: unknown): string => (typeof v === 'string' ? v.toUpperCase() : '');

/** The safety car's message, by kind: deployed, or on its way in. */
function safetyCar(message: string): Track {
  const vsc = /\bVSC\b|VIRTUAL SAFETY CAR/.test(message);
  if (/ENDING|IN THIS LAP/.test(message)) return vsc ? 'vscEnd' : 'scEnd';
  return vsc ? 'vsc' : 'sc';
}

/** The mark for a race control row, from F1's `category`, `flag` and, for the red flag, its text. */
export function signalOf(r: Record<string, unknown>): Signal {
  const flag = upper(r.flag);
  const message = text(r);
  if (/^RED FLAG\b/.test(message) || flag === 'RED') return 'red';
  if (r.category === 'SafetyCar') return safetyCar(message);
  if (flag === 'GREEN' || flag === 'CLEAR') return 'green';
  if (flag === 'DOUBLE YELLOW') return 'double';
  if (flag.includes('YELLOW')) return 'yellow';
  if (flag === 'BLUE') return 'blue';
  if (flag === 'BLACK AND WHITE') return 'blackwhite';
  if (flag.startsWith('BLACK')) return 'black';
  if (flag === 'CHEQUERED') return 'chequered';
  return 'note';
}

/** Where a stewards' case is. */
export type Stage = 'noted' | 'investigating' | 'after the race' | 'no action' | 'penalty' | 'served';

/** One message about a stewards' case. The case is known by its incident time and the cars in it. */
export interface CaseStep {
  time: string;
  cars: number[];
  turn: number | null;
  reason: string;
  stage: Stage;
  /** "5s", for a penalty or one served. */
  penalty: string | null;
}

const STAGES: Record<string, Stage> = {
  NOTED: 'noted',
  'UNDER INVESTIGATION': 'investigating',
  'WILL BE INVESTIGATED AFTER THE RACE': 'after the race',
  'REVIEWED NO FURTHER INVESTIGATION': 'no action',
  'NO FURTHER ACTION': 'no action',
};

const carsIn = (s: string): number[] => [...s.matchAll(/(\d+) \(\w+\)/g)].map((m) => Number(m[1]));
// "FAILING TO FOLLOW RACE DIRECTORS INSTRUCTIONS – PRACTICE START INFRINGEMENT" says it in its last part.
const reasonOf = (r: string | undefined): string => (r ? (r.split(' – ').at(-1) ?? r) : '');
const stewards = (message: string): string => message.replace(/^FIA STEWARDS: /, '');

/** The case a message is about, or null if it isn't about one. */
export function parseCase(message: string): CaseStep | null {
  const s = stewards(message);
  let m = s.match(
    /^(?:TURN (\d+) )?INCIDENT INVOLVING CARS? (.+?) (NOTED|UNDER INVESTIGATION|WILL BE INVESTIGATED AFTER THE RACE|REVIEWED NO FURTHER INVESTIGATION|NO FURTHER ACTION)(?: - (.+?))? \((\d\d:\d\d:\d\d)\)$/,
  );
  if (m) return { time: m[5], cars: carsIn(m[2]), turn: m[1] ? Number(m[1]) : null, reason: reasonOf(m[4]), stage: STAGES[m[3]], penalty: null };
  m = s.match(/^PENALTY SERVED - (\d+) SECOND TIME PENALTY FOR CAR (\d+) \(\w+\)(?: - (.+?))? \((\d\d:\d\d:\d\d)\)$/);
  if (m) return { time: m[4], cars: [Number(m[2])], turn: null, reason: reasonOf(m[3]), stage: 'served', penalty: `${m[1]}s` };
  m = s.match(/^(\d+) SECOND TIME PENALTY FOR CAR (\d+) \(\w+\) - (.+?) \((\d\d:\d\d:\d\d)\)$/);
  if (m) return { time: m[4], cars: [Number(m[2])], turn: null, reason: reasonOf(m[3]), stage: 'penalty', penalty: `${m[1]}s` };
  return null;
}

/** Whether two steps are of one case: the same incident time, and a car in common. */
export const sameCase = (a: { time: string; cars: number[] }, b: { time: string; cars: number[] }): boolean =>
  a.time === b.time && a.cars.some((c) => b.cars.includes(c));

/** A stage as it's read: "5s penalty", "5s served". */
export const stageLabel = (stage: Stage, penalty: string | null): string =>
  stage === 'penalty' ? `${penalty} penalty` : stage === 'served' ? `${penalty} served` : stage;

/** Cars in a list, as drivers between `sep`: "ALB & GAS". */
const joined = (cars: readonly number[], sep: string): Part[] => cars.flatMap((car, i): Part[] => (i ? [sep, { driver: car }] : [{ driver: car }]));

/** Empty strings left out, so a line's first part is what it starts with. */
const tidy = (parts: Part[]): Part[] => parts.filter((p) => p !== '');

/**
 * Text with each car F1 names in it as a driver: "CAR 23 (ALB)", "CARS 23 (ALB) AND 10 (GAS)". A word
 * `driverOf` knows as a roster code, standing alone, is one too.
 */
export function withCars(s: string, driverOf: (word: string) => number | null = () => null): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const m of s.matchAll(/(?:\bCARS? )?\b(\d+) \(\w+\)|\b[A-Z]{3}\b/g)) {
    const driver = m[1] !== undefined ? Number(m[1]) : driverOf(m[0]);
    if (driver === null) continue;
    out.push(s.slice(at, m.index), { driver });
    at = m.index + m[0].length;
  }
  out.push(s.slice(at));
  return tidy(out);
}

/**
 * A message in fewer words, with its cars as drivers: "ALB LAP 34 DELETED · T1 LIMITS" for "CAR 23 (ALB)
 * TIME 1:18.737 DELETED - TRACK LIMITS AT TURN 1 LAP 34 14:50:00". Still in capitals; `sentenceCase`
 * lowers it. A list of numbers, as the restart order gives them, is a list of cars.
 */
export function shorten(message: string, driverOf?: (word: string) => number | null): Part[] {
  const s = stewards(message);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^CAR (\d+) \(\w+\) (?:TIME [\d:.]+ )?(?:LAP )?DELETED - TRACK LIMITS AT TURN (\d+) LAP (\d+)/)))
    return [{ driver: Number(m[1]) }, ` LAP ${m[3]} DELETED · T${m[2]} LIMITS`];
  if ((m = s.match(/^WAVED BLUE FLAG FOR CAR (\d+) \(\w+\)/))) return ['BLUE FLAG ', { driver: Number(m[1]) }];
  if ((m = s.match(/^BLACK AND WHITE FLAG FOR CAR (\d+) \(\w+\) - (.+)/))) return [{ driver: Number(m[1]) }, ` BLACK AND WHITE FLAG · ${m[2]}`];
  if ((m = s.match(/^(DOUBLE YELLOW|YELLOW|CLEAR) IN TRACK SECTOR (\d+)$/))) return [`${m[1]} S${m[2]}`];
  const step = parseCase(message);
  if (step) {
    const who = joined(step.cars, ' & ');
    if (step.penalty) return [...who, ` ${step.penalty.toUpperCase()} PENALTY ${step.stage === 'served' ? 'SERVED' : `· ${step.reason}`}`];
    return tidy([step.turn ? `T${step.turn} ` : '', ...who, ` ${step.stage.toUpperCase()}${step.reason ? ` · ${step.reason}` : ''}`]);
  }
  const rest = s
    .replace(/ TIMED AT \d\d:\d\d:\d\d/, '')
    .replace(/ \(\d\d:\d\d:\d\d\)$/, '')
    .replace(/^GREEN LIGHT - /, '');
  if ((m = rest.match(/^(.*ORDER: )([\d, ]+)$/)))
    return [...withCars(m[1], driverOf), ...joined(m[2].split(/,\s*/).map(Number), ' ')];
  return withCars(rest, driverOf);
}

/** The case's own line: "T6 BEA & SAI · CAUSING A COLLISION". */
export function caseText(c: { turn: number | null; cars: number[]; reason: string }): Part[] {
  return tidy([c.turn ? `T${c.turn} ` : '', ...joined(c.cars, ' & '), c.reason ? ` · ${c.reason}` : '']);
}

/** Capitals kept only for turns, sectors and the like, so those stand out; drivers are drawn as codes. */
export function sentenceCase(parts: readonly Part[]): Part[] {
  const out = parts.map((p) =>
    typeof p === 'string'
      ? p
          .split(' ')
          .map((w) => (/^(FIA|F1|DRS|VSC|SC|T\d+|S\d+|L\d+)$/.test(w.replace(/[^A-Za-z0-9]/g, '').toUpperCase()) ? w.toUpperCase() : w.toLowerCase()))
          .join(' ')
      : p,
  );
  const first = out[0];
  return typeof first === 'string' && /^[a-z]/.test(first) ? [first[0].toUpperCase() + first.slice(1), ...out.slice(1)] : out;
}

/** A stewards' case as it stands: its cars, why, and its latest stage. */
export interface Case {
  time: string;
  cars: number[];
  turn: number | null;
  reason: string;
  stage: Stage;
  /** "5s", once a penalty is given, and the car it's for. */
  penalty: string | null;
  penalised: number[];
  /** The lap of its latest message. */
  lap: number | null;
}

/** What is in force at the end of `rows`, oldest first. Each is null until a message has said it. */
export interface Standing {
  track: Track;
  /** The lap the red flag, safety car or VSC in force began on, or null when racing. */
  since: number | null;
  /** While the red flag is out: the order the cars restart in, and when, once race control has said. */
  restart: { order: number[]; at: string | null } | null;
  /** Sectors under a yellow, by number. */
  sectors: Map<number, 'yellow' | 'double'>;
  grip: 'low' | 'normal' | null;
  /** The season's aid, "OVERTAKE" or "DRS", and whether it's on. */
  aid: { name: string; on: boolean } | null;
  /** Stewards' cases noted or under investigation, not yet decided. */
  open: number;
  /** Every case so far, in the order each was first noted. */
  cases: Case[];
  /** Laps deleted for track limits, by car. */
  deleted: Map<number, number>;
  /** Cars shown the black and white flag. */
  blackWhite: Set<number>;
  /** The lap of the latest message. */
  lap: number | null;
}

const isOpen = (stage: Stage): boolean => stage === 'noted' || stage === 'investigating';

export function standing(rows: ReadonlyArray<Record<string, unknown>>): Standing {
  const sectors = new Map<number, 'yellow' | 'double'>();
  let track: Track = 'green';
  let since: number | null = null;
  let restart = null as Standing['restart'];
  let grip: Standing['grip'] = null;
  let aid: Standing['aid'] = null;
  let lap: number | null = null;
  const cases: Case[] = [];
  const deleted = new Map<number, number>();
  const blackWhite = new Set<number>();
  for (const r of rows) {
    const message = text(r);
    const flag = upper(r.flag);
    const sector = num(r.sector);
    lap = num(r.lap_number) ?? lap;
    if (r.scope === 'Sector' && sector !== null) {
      if (flag === 'CLEAR') sectors.delete(sector);
      else if (flag.includes('YELLOW')) sectors.set(sector, flag === 'DOUBLE YELLOW' ? 'double' : 'yellow');
    }
    // A red flag holds until the session starts again; a track clear or green flag ends a safety car's period.
    const was = track;
    if (/^RED FLAG\b/.test(message)) track = 'red';
    else if (track === 'red') {
      if (r.category === 'SessionStatus' && message === 'SESSION STARTED') track = 'green';
    } else if (r.category === 'SafetyCar') track = safetyCar(message);
    else if (r.scope === 'Track' && (flag === 'CLEAR' || flag === 'GREEN')) track = 'green';
    // A safety car's end is still its period; a red flag after a safety car starts a new one.
    if (track === 'green') since = null;
    else if (was === 'green' || (track === 'red') !== (was === 'red')) since = lap;
    if (track !== 'red') restart = null;
    else {
      const order = message.match(/RESUMPTION ORDER: ([\d,\s]+)$/);
      const at = message.match(/^RACE WILL RESUME AT (\d\d:\d\d)/);
      const now = restart;
      if (order) restart = { order: order[1].split(/,\s*/).map(Number), at: now?.at ?? null };
      else if (at) restart = { order: now?.order ?? [], at: at[1] };
    }
    if (/^(LOW|NORMAL) GRIP CONDITIONS$/.test(message)) grip = message.startsWith('LOW') ? 'low' : 'normal';
    const aidMatch = message.match(/^(OVERTAKE|DRS) (ENABLED|DISABLED)$/);
    if (aidMatch) aid = { name: aidMatch[1], on: aidMatch[2] === 'ENABLED' };
    const limits = message.match(/^CAR (\d+) \(\w+\) (?:TIME [\d:.]+ )?(?:LAP )?DELETED - TRACK LIMITS/);
    if (limits) deleted.set(Number(limits[1]), (deleted.get(Number(limits[1])) ?? 0) + 1);
    const driver = num(r.driver_number);
    if (flag === 'BLACK AND WHITE' && driver !== null) blackWhite.add(driver);
    const step = parseCase(message);
    if (step) {
      let known = cases.find((c) => sameCase(c, step));
      if (!known) {
        known = { time: step.time, cars: step.cars, turn: step.turn, reason: step.reason, stage: step.stage, penalty: null, penalised: [], lap };
        cases.push(known);
      }
      known.stage = step.stage;
      known.lap = lap;
      if (!known.reason) known.reason = step.reason;
      if (step.penalty) {
        known.penalty = step.penalty;
        known.penalised = step.cars;
      }
    }
  }
  const open = cases.filter((c) => isOpen(c.stage)).length;
  return { track, since, restart, sectors, grip, aid, open, cases, deleted, blackWhite, lap };
}
