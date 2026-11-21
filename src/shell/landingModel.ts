/**
 * The landing page's tape, worked out from the schedule: every session as a row in one column of time, what a
 * row says about when it is, and the prompt a row and its suffixes write. Pure. It only reads the calendar,
 * which says when a session is and never what happened in it.
 */
import type { Schedule } from '../../shared/sessionData';

export type TapeStatus = 'upcoming' | 'live' | 'past';
export type TapeKind = 'race' | 'qualifying' | 'practice';

export interface TapeSession {
  key: number;
  meetingKey: number;
  year: number;
  round: number | null;
  /** The meeting as a viewer names it: "Las Vegas", without "Grand Prix". */
  meeting: string;
  /** "Practice 1", "Sprint Qualifying", "Race". */
  label: string;
  kind: TapeKind;
  startMs: number;
  endMs: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A sprint is a race and a sprint shootout is qualifying, for which suffixes fit. */
export function kindOf(name: string, type: string): TapeKind {
  const text = `${name} ${type}`.toLowerCase();
  if (/qualifying|shootout/.test(text)) return 'qualifying';
  if (/race|sprint/.test(text)) return 'race';
  return 'practice';
}

/**
 * A session's name as its row says it. F1 TV titles one that's coming up in full, "2026 Qatar GP - Practice 3"
 * or "2026 Qatar Grand Prix" for the race, where the archive says "Practice 3" and "Race".
 */
export function labelOf(name: string, type: string): string {
  const tail = (name.split(' - ').at(-1) ?? name).trim();
  if (/practice|qualifying|shootout|sprint|race|day/i.test(tail)) return tail;
  const byType: Record<string, string> = { race: 'Race', sprint: 'Sprint', qualifying: 'Qualifying', 'sprint-qualifying': 'Sprint Qualifying' };
  return byType[type.toLowerCase()] ?? tail;
}

/** F1 TV also lists the shows around a session, which aren't sessions to open here. */
const NOT_A_SESSION = new Set(['show', 'other']);

/** Every session with a start time, earliest first. One without an end is given its usual length. */
export function tapeSessions(schedule: Pick<Schedule, 'meetings' | 'sessions'>): TapeSession[] {
  const meetings = new Map(schedule.meetings.map((m) => [m.meeting_key, m]));
  const out: TapeSession[] = [];
  for (const s of schedule.sessions) {
    if (s.date_start == null || NOT_A_SESSION.has(s.session_type.toLowerCase())) continue;
    const meeting = meetings.get(s.meeting_key);
    const kind = kindOf(s.session_name, s.session_type);
    out.push({
      key: s.session_key,
      meetingKey: s.meeting_key,
      year: s.year,
      round: meeting?.round ?? null,
      meeting: (meeting?.meeting_name ?? '').replace(/\s*Grand Prix\s*$/i, '').trim() || (meeting?.meeting_name ?? ''),
      label: labelOf(s.session_name, s.session_type),
      kind,
      startMs: s.date_start,
      endMs: s.date_end != null && s.date_end > s.date_start ? s.date_end : s.date_start + (kind === 'race' ? 2 : 1) * HOUR,
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export function statusAt(session: TapeSession, now: number): TapeStatus {
  return now < session.startMs ? 'upcoming' : now < session.endMs ? 'live' : 'past';
}

/** The session the tape opens on: what's live, else what's next, else the last one finished. */
export function frontSession(sessions: TapeSession[], now: number): TapeSession | null {
  return sessions.find((s) => statusAt(s, now) === 'live') ?? sessions.find((s) => statusAt(s, now) === 'upcoming') ?? sessions.at(-1) ?? null;
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  if (hours < 48) return `1d ${hours % 24}h`;
  return `${Math.round(hours / 24)}d`;
}

/** How far a session is from now. One long finished says nothing: its date is on its weekend's line. */
export function relative(session: TapeSession, now: number): string {
  const status = statusAt(session, now);
  if (status === 'upcoming') return `in ${span(session.startMs - now)}`;
  if (status === 'live') return `live · ${span(now - session.startMs)} in`;
  const ago = now - session.endMs;
  return ago > 14 * DAY ? '' : `${span(ago)} ago`;
}

export type TapeRow =
  | { type: 'year'; year: number }
  | { type: 'meeting'; id: string; round: number | null; name: string; startMs: number; endMs: number }
  | { type: 'now' }
  | { type: 'session'; session: TapeSession; status: TapeStatus; next: boolean };

/**
 * The tape's rows from the top: the furthest session ahead first, a line at now, then what's finished, newest
 * first. Each weekend's sessions sit under its name, which is said again under the line when now falls inside it.
 */
export function tapeRows(sessions: TapeSession[], now: number): TapeRow[] {
  const ranges = new Map<number, { startMs: number; endMs: number }>();
  for (const s of sessions) {
    const range = ranges.get(s.meetingKey);
    if (!range) ranges.set(s.meetingKey, { startMs: s.startMs, endMs: s.startMs });
    else range.endMs = Math.max(range.endMs, s.startMs);
  }
  const live = sessions.some((s) => statusAt(s, now) === 'live');
  const nextKey = live ? null : (sessions.find((s) => statusAt(s, now) === 'upcoming')?.key ?? null);
  const rows: TapeRow[] = [];
  let year: number | null = null;
  let meeting: number | null = null;
  let line = false;
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i];
    const status = statusAt(session, now);
    if (session.year !== year) {
      rows.push({ type: 'year', year: session.year });
      year = session.year;
      meeting = null;
    }
    if (status === 'past' && !line) {
      rows.push({ type: 'now' });
      line = true;
      meeting = null;
    }
    if (session.meetingKey !== meeting) {
      const range = ranges.get(session.meetingKey)!;
      rows.push({ type: 'meeting', id: `${session.meetingKey}${line ? '-past' : ''}`, round: session.round, name: session.meeting, ...range });
      meeting = session.meetingKey;
    }
    rows.push({ type: 'session', session, status, next: session.key === nextKey });
  }
  if (!line && sessions.length > 0) rows.push({ type: 'now' });
  return rows;
}

/** Something to add after a session's name: where to start it, or what to show with it. */
export interface Suffix {
  id: string;
  /** One start at most; any number of things to show. */
  group: 'start' | 'with';
  text: string;
  kinds?: TapeKind[];
  when?: TapeStatus[];
}

/**
 * Each names only what's known before the session starts, the grid or the standings, so adding one to a
 * finished session gives nothing away.
 */
export const SUFFIXES: Suffix[] = [
  { id: 'live', group: 'start', text: 'join it live', when: ['live'] },
  { id: 'begin', group: 'start', text: 'from the start', when: ['live'] },
  { id: 'wait', group: 'start', text: 'open it when it starts', when: ['upcoming'] },
  { id: 'lights', group: 'start', text: 'jump to 30 seconds before lights out', kinds: ['race'], when: ['past', 'live'] },
  { id: 'q3', group: 'start', text: 'jump to the start of Q3', kinds: ['qualifying'], when: ['past'] },
  { id: 'green', group: 'start', text: 'jump to the first green light', kinds: ['practice'], when: ['past'] },
  { id: 'top3', group: 'with', text: 'with onboards of the top 3 on the grid', kinds: ['race'] },
  { id: 'champ', group: 'with', text: 'with onboards of the championship top 3', kinds: ['qualifying', 'practice'] },
  { id: 'tower', group: 'with', text: 'with the timing tower and track map' },
  { id: 'gap', group: 'with', text: 'with the gap between the top two', kinds: ['race'] },
  { id: 'sectors', group: 'with', text: 'with the sector table', kinds: ['qualifying'] },
  { id: 'deg', group: 'with', text: 'with the tyre deg chart', kinds: ['practice'] },
];

export function suffixesFor(session: TapeSession, now: number): Suffix[] {
  const status = statusAt(session, now);
  return SUFFIXES.filter((s) => (!s.kinds || s.kinds.includes(session.kind)) && (!s.when || s.when.includes(status)));
}

/** Adds a suffix, or takes it off if it's on. A start replaces the one already chosen. */
export function toggleSuffix(chosen: string[], id: string): string[] {
  if (chosen.includes(id)) return chosen.filter((c) => c !== id);
  const added = SUFFIXES.find((s) => s.id === id);
  if (!added) return chosen;
  const kept = added.group === 'start' ? chosen.filter((c) => SUFFIXES.find((s) => s.id === c)?.group !== 'start') : chosen;
  return [...kept, id];
}

/** The session as the viewer would type it: "2026 Las Vegas race". */
export function sessionName(session: TapeSession): string {
  return `${session.year} ${session.meeting} ${session.label.toLowerCase()}`.replace(/\s+/g, ' ').trim();
}

/** The prompt a row and its suffixes write: the session, where to start, then everything to show joined by "and". */
export function promptFor(session: TapeSession, chosen: string[]): string {
  const picked = SUFFIXES.filter((s) => chosen.includes(s.id));
  const starts = picked.filter((s) => s.group === 'start').map((s) => `, ${s.text}`);
  const shown = picked.filter((s) => s.group === 'with').map((s, i) => (i === 0 ? `, ${s.text}` : ` and ${s.text.replace(/^with /, '')}`));
  return sessionName(session) + starts.join('') + shown.join('');
}
