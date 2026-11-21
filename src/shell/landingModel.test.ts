import { describe, expect, it } from 'vitest';
import type { Meeting, ScheduleSession } from '../../shared/sessionData';
import { frontSession, kindOf, labelOf, promptFor, relative, statusAt, suffixesFor, tapeRows, tapeSessions, toggleSuffix } from './landingModel';

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

function meeting(key: number, name: string, round: number): Meeting {
  return {
    meeting_key: key,
    meeting_name: name,
    meeting_official_name: null,
    year: 2026,
    round,
    location: null,
    country_key: null,
    country_code: null,
    country_name: null,
    circuit_key: null,
    circuit_short_name: null,
    gmt_offset: null,
    date_start: null,
    date_end: null,
  };
}

function session(key: number, meetingKey: number, name: string, type: string, start: string | null, hours: number | null = 1): ScheduleSession {
  const date_start = start ? at(start) : null;
  return { session_key: key, meeting_key: meetingKey, session_name: name, session_type: type, year: 2026, date_start, date_end: date_start != null && hours != null ? date_start + hours * HOUR : null, gmt_offset: null, path: null };
}

const schedule = {
  meetings: [meeting(1, 'São Paulo Grand Prix', 21), meeting(2, 'Las Vegas Grand Prix', 22)],
  sessions: [
    session(22, 2, 'Race', 'race', '2026-11-22T04:00Z', null),
    session(11, 1, 'Race', 'Race', '2026-11-08T17:00Z', 2),
    session(21, 2, 'Qualifying', 'Qualifying', '2026-11-21T04:00Z'),
    session(10, 1, 'Sprint Qualifying', 'Qualifying', '2026-11-06T18:00Z'),
    session(99, 2, 'Unscheduled', 'Practice', null),
    session(98, 2, 'Pre-Race Show - Las Vegas', 'show', '2026-11-22T02:50Z'),
  ],
};
const sessions = tapeSessions(schedule);
const race = sessions.find((s) => s.key === 22)!;
const raceDay = at('2026-11-21T18:48Z');

describe('the tape', () => {
  it('lists sessions earliest first, named as a viewer would, without shows or the ones that have no time', () => {
    expect(sessions.map((s) => s.key)).toEqual([10, 11, 21, 22]);
    expect(race.meeting).toBe('Las Vegas');
    expect(race.round).toBe(22);
    // No end listed: a race is given two hours.
    expect(race.endMs - race.startMs).toBe(2 * HOUR);
  });

  it('shortens the full title F1 TV gives a session that is coming up', () => {
    expect(labelOf('2026 Qatar GP - Practice 3', 'practice')).toBe('Practice 3');
    expect(labelOf('2026 Qatar Grand Prix', 'race')).toBe('Race');
    expect(labelOf('Sprint Qualifying', 'Qualifying')).toBe('Sprint Qualifying');
  });

  it('counts a sprint as a race and a shootout as qualifying', () => {
    expect(kindOf('Sprint', 'Race')).toBe('race');
    expect(kindOf('Sprint Qualifying', 'Qualifying')).toBe('qualifying');
    expect(kindOf('Sprint Shootout', 'Qualifying')).toBe('qualifying');
    expect(kindOf('Practice 2', 'Practice')).toBe('practice');
    expect(kindOf('Day 1', '')).toBe('practice');
  });

  it('puts what is coming above the line at now and what is finished below, newest first', () => {
    const rows = tapeRows(sessions, raceDay).map((r) => (r.type === 'session' ? `${r.session.key}${r.next ? ' next' : ''}` : r.type === 'meeting' ? r.name : r.type));
    expect(rows).toEqual(['year', 'Las Vegas', '22 next', 'now', 'Las Vegas', '21', 'São Paulo', '11', '10']);
  });

  it('marks no session as next while one is live', () => {
    const live = at('2026-11-22T04:24Z');
    expect(statusAt(race, live)).toBe('live');
    expect(frontSession(sessions, live)?.key).toBe(22);
    expect(tapeRows(sessions, live).some((r) => r.type === 'session' && r.next)).toBe(false);
  });

  it('ends on the line when nothing has finished, and opens on the last session when the season is over', () => {
    expect(tapeRows(sessions, at('2026-01-01T00:00Z')).at(-1)).toEqual({ type: 'now' });
    expect(frontSession(sessions, at('2027-01-01T00:00Z'))?.key).toBe(22);
  });

  it('says how far a session is, and nothing once it is long finished', () => {
    expect(relative(race, raceDay)).toBe('in 9h 12m');
    expect(relative(race, at('2026-11-22T04:24Z'))).toBe('live · 24m in');
    expect(relative(race, at('2026-11-22T08:00Z'))).toBe('2h 0m ago');
    expect(relative(race, at('2026-12-25T00:00Z'))).toBe('');
  });
});

describe('suffixes', () => {
  const ids = (now: number) => suffixesFor(race, now).map((s) => s.id);

  it('fit the kind of session and whether it has started', () => {
    expect(ids(raceDay)).toEqual(['wait', 'top3', 'tower', 'gap']);
    expect(ids(at('2026-11-22T04:24Z'))).toEqual(['live', 'begin', 'lights', 'top3', 'tower', 'gap']);
    expect(ids(at('2026-11-23T00:00Z'))).toEqual(['lights', 'top3', 'tower', 'gap']);
  });

  it('keep one start, and any number of things to show', () => {
    expect(toggleSuffix(['live', 'top3'], 'lights')).toEqual(['top3', 'lights']);
    expect(toggleSuffix(['lights', 'top3'], 'tower')).toEqual(['lights', 'top3', 'tower']);
    expect(toggleSuffix(['lights', 'top3'], 'top3')).toEqual(['lights']);
  });

  it('write the prompt: the session, where to start, then what to show joined by "and"', () => {
    expect(promptFor(race, [])).toBe('2026 Las Vegas race');
    expect(promptFor(race, ['tower', 'top3', 'lights'])).toBe(
      '2026 Las Vegas race, jump to 30 seconds before lights out, with onboards of the top 3 on the grid and the timing tower and track map',
    );
  });
});
