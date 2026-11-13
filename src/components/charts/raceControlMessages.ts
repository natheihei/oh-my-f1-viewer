/**
 * Reading race control's messages. The feed fills its structured columns only for flags: a sector's
 * yellow has `scope` and `sector`, a blue or black and white flag has `driver_number`, a safety car has
 * `category` SafetyCar. Deleted laps, the stewards' cases, penalties, the red flag and the restart order
 * come as plain text, so what they say is read from F1's wording here. A message no pattern knows is
 * shown as sent, with only car numbers and clock times taken out.
 */
import { num } from './kit';

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

/**
 * A message in fewer words: "ALB LAP 34 DELETED · T1 LIMITS" for "CAR 23 (ALB) TIME 1:18.737 DELETED -
 * TRACK LIMITS AT TURN 1 LAP 34 14:50:00". Still in capitals; `sentenceCase` lowers it. `codeOf` names a
 * car in a list of numbers, as the restart order gives them.
 */
export function shorten(message: string, codeOf: (n: number) => string): string {
  const s = stewards(message);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^CAR \d+ \((\w+)\) (?:TIME [\d:.]+ )?(?:LAP )?DELETED - TRACK LIMITS AT TURN (\d+) LAP (\d+)/)))
    return `${m[1]} LAP ${m[3]} DELETED · T${m[2]} LIMITS`;
  if ((m = s.match(/^WAVED BLUE FLAG FOR CAR \d+ \((\w+)\)/))) return `BLUE FLAG ${m[1]}`;
  if ((m = s.match(/^BLACK AND WHITE FLAG FOR CAR \d+ \((\w+)\) - (.+)/))) return `${m[1]} BLACK AND WHITE FLAG · ${m[2]}`;
  if ((m = s.match(/^(DOUBLE YELLOW|YELLOW|CLEAR) IN TRACK SECTOR (\d+)$/))) return `${m[1]} S${m[2]}`;
  const step = parseCase(message);
  if (step) {
    const who = step.cars.map(codeOf).join(' & ');
    if (step.penalty) return `${who} ${step.penalty.toUpperCase()} PENALTY ${step.stage === 'served' ? 'SERVED' : `· ${step.reason}`}`;
    return `${step.turn ? `T${step.turn} ` : ''}${who} ${step.stage.toUpperCase()}${step.reason ? ` · ${step.reason}` : ''}`;
  }
  return s
    .replace(/ORDER: ([\d, ]+)$/, (_, list: string) => `ORDER: ${list.split(/,\s*/).map((n) => codeOf(Number(n))).join(' ')}`)
    .replace(/CARS? (\d+) \((\w+)\)/g, '$2')
    .replace(/ TIMED AT \d\d:\d\d:\d\d/, '')
    .replace(/ \(\d\d:\d\d:\d\d\)$/, '')
    .replace(/^GREEN LIGHT - /, '');
}

/** The case's own line: "T6 BEA & SAI · CAUSING A COLLISION". */
export function caseText(c: { turn: number | null; cars: number[]; reason: string }, codeOf: (n: number) => string): string {
  return `${c.turn ? `T${c.turn} ` : ''}${c.cars.map(codeOf).join(' & ')}${c.reason ? ` · ${c.reason}` : ''}`;
}

/** Capitals kept only for driver codes, turns, sectors and the like, so those stand out. */
export function sentenceCase(s: string, isCode: (word: string) => boolean): string {
  const out = s
    .split(' ')
    .map((w) => {
      const core = w.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      return isCode(core) || /^(FIA|F1|DRS|VSC|SC|T\d+|S\d+|L\d+)$/.test(core) ? w.toUpperCase() : w.toLowerCase();
    })
    .join(' ');
  const i = out.search(/[a-z]/);
  return i === 0 ? out[0].toUpperCase() + out.slice(1) : out;
}

/** What is in force at the end of `rows`, oldest first. Each is null until a message has said it. */
export interface Standing {
  track: Track;
  /** Sectors under a yellow, by number. */
  sectors: Map<number, 'yellow' | 'double'>;
  grip: 'low' | 'normal' | null;
  /** The season's aid, "OVERTAKE" or "DRS", and whether it's on. */
  aid: { name: string; on: boolean } | null;
  /** Stewards' cases noted or under investigation, not yet decided. */
  open: number;
}

export function standing(rows: ReadonlyArray<Record<string, unknown>>): Standing {
  const sectors = new Map<number, 'yellow' | 'double'>();
  let track: Track = 'green';
  let grip: Standing['grip'] = null;
  let aid: Standing['aid'] = null;
  const cases: Array<{ time: string; cars: number[]; stage: Stage }> = [];
  for (const r of rows) {
    const message = text(r);
    const flag = upper(r.flag);
    const sector = num(r.sector);
    if (r.scope === 'Sector' && sector !== null) {
      if (flag === 'CLEAR') sectors.delete(sector);
      else if (flag.includes('YELLOW')) sectors.set(sector, flag === 'DOUBLE YELLOW' ? 'double' : 'yellow');
    }
    // A red flag holds until the session starts again; a track clear or green flag ends a safety car's period.
    if (/^RED FLAG\b/.test(message)) track = 'red';
    else if (track === 'red') {
      if (r.category === 'SessionStatus' && message === 'SESSION STARTED') track = 'green';
    } else if (r.category === 'SafetyCar') track = safetyCar(message);
    else if (r.scope === 'Track' && (flag === 'CLEAR' || flag === 'GREEN')) track = 'green';
    if (/^(LOW|NORMAL) GRIP CONDITIONS$/.test(message)) grip = message.startsWith('LOW') ? 'low' : 'normal';
    const aidMatch = message.match(/^(OVERTAKE|DRS) (ENABLED|DISABLED)$/);
    if (aidMatch) aid = { name: aidMatch[1], on: aidMatch[2] === 'ENABLED' };
    const step = parseCase(message);
    if (step) {
      const known = cases.find((c) => sameCase(c, step));
      if (known) known.stage = step.stage;
      else cases.push({ time: step.time, cars: step.cars, stage: step.stage });
    }
  }
  const open = cases.filter((c) => c.stage === 'noted' || c.stage === 'investigating').length;
  return { track, sectors, grip, aid, open };
}
