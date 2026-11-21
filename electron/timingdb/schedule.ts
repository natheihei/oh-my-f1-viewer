/**
 * The calendar: what has happened from F1's season indexes, plus what's coming from F1 TV, since the
 * indexes only list sessions once they've taken place. Pure.
 */
import { localToUtc } from '../../shared/feedTime';
import type { EventInfo, SessionInfo } from '../../shared/api';
import type { Meeting, Schedule, ScheduleSession } from '../../shared/sessionData';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function fromSeasonIndex(index: any, year: number): { meetings: Meeting[]; sessions: ScheduleSession[] } {
  const meetings: Meeting[] = [];
  const sessions: ScheduleSession[] = [];
  for (const m of index?.Meetings ?? []) {
    const meetingKey = Number(m?.Key);
    if (!Number.isInteger(meetingKey)) continue;
    const list: any[] = m.Sessions ?? [];
    const own: ScheduleSession[] = [];
    for (const s of list) {
      const sessionKey = Number(s?.Key);
      if (!Number.isInteger(sessionKey) || sessionKey <= 0) continue;
      own.push({
        session_key: sessionKey,
        meeting_key: meetingKey,
        session_name: String(s.Name ?? ''),
        session_type: String(s.Type ?? ''),
        year,
        date_start: localToUtc(s.StartDate, s.GmtOffset),
        date_end: localToUtc(s.EndDate, s.GmtOffset),
        gmt_offset: s.GmtOffset ?? null,
        path: typeof s.Path === 'string' ? s.Path : null,
      });
    }
    const starts = own.map((s) => s.date_start).filter((t): t is number => t !== null);
    const ends = own.map((s) => s.date_end).filter((t): t is number => t !== null);
    meetings.push({
      meeting_key: meetingKey,
      meeting_name: String(m.Name ?? ''),
      meeting_official_name: m.OfficialName ?? null,
      year,
      round: typeof m.Number === 'number' ? m.Number : null,
      location: m.Location ?? null,
      country_key: m.Country?.Key ?? null,
      country_code: m.Country?.Code ?? null,
      country_name: m.Country?.Name ?? null,
      circuit_key: m.Circuit?.Key ?? null,
      circuit_short_name: m.Circuit?.ShortName ?? null,
      gmt_offset: own[0]?.gmt_offset ?? null,
      date_start: starts.length ? Math.min(...starts) : null,
      date_end: ends.length ? Math.max(...ends) : null,
    });
    sessions.push(...own);
  }
  return { meetings, sessions };
}

/** Sessions F1 TV has listed as coming up. Without keys there's nothing to attach data to later. */
export function fromUpcoming(upcoming: SessionInfo[], events: EventInfo[]): { meetings: Meeting[]; sessions: ScheduleSession[] } {
  const meetings = new Map<number, Meeting>();
  /** Meetings whose event has been found. A show the day before the event starts falls outside it, so a later session names it. */
  const matched = new Set<number>();
  const sessions: ScheduleSession[] = [];
  for (const s of upcoming) {
    if (s.series !== 'FORMULA 1') continue;
    const meetingKey = Number(s.meetingKey);
    const sessionKey = Number(s.sessionKey);
    if (!meetingKey || !sessionKey) continue;
    sessions.push({
      session_key: sessionKey,
      meeting_key: meetingKey,
      session_name: s.title,
      session_type: s.type,
      year: s.year,
      date_start: s.startMs,
      date_end: s.endMs,
      gmt_offset: null,
      path: null,
    });
    const event = matched.has(meetingKey) ? undefined : events.find((e) => s.startMs !== null && e.startMs <= s.startMs && s.startMs <= e.endMs);
    if (event) matched.add(meetingKey);
    const listed = meetings.get(meetingKey);
    if (!listed || event) {
      meetings.set(meetingKey, {
        meeting_key: meetingKey,
        meeting_name: event?.shortName ?? s.title,
        meeting_official_name: event?.name ?? null,
        year: s.year,
        round: event?.round ?? null,
        location: null,
        country_key: null,
        country_code: null,
        country_name: null,
        circuit_key: null,
        circuit_short_name: null,
        gmt_offset: null,
        date_start: event?.startMs ?? listed?.date_start ?? s.startMs,
        date_end: event?.endMs ?? listed?.date_end ?? s.endMs,
      });
    }
  }
  return { meetings: [...meetings.values()], sessions };
}

/** Later sources only add: what the index says about a session wins over the listing of it as coming up. */
export function mergeSchedule(parts: Array<{ meetings: Meeting[]; sessions: ScheduleSession[] }>, refreshedAt: number): Schedule {
  const meetings = new Map<number, Meeting>();
  const sessions = new Map<number, ScheduleSession>();
  for (const part of parts) {
    for (const m of part.meetings) if (!meetings.has(m.meeting_key)) meetings.set(m.meeting_key, m);
    for (const s of part.sessions) if (!sessions.has(s.session_key)) sessions.set(s.session_key, s);
  }
  const byStart = (a: { date_start: number | null }, b: { date_start: number | null }) => (a.date_start ?? Infinity) - (b.date_start ?? Infinity);
  return { meetings: [...meetings.values()].sort(byStart), sessions: [...sessions.values()].sort(byStart), refreshedAt };
}
