import { describe, expect, it } from 'vitest';
import type { EventInfo, SessionInfo } from '../../shared/api';
import { fromSeasonIndex, fromUpcoming, mergeSchedule } from './schedule';

const INDEX = {
  Meetings: [
    {
      Key: 1298,
      Name: 'Mexico City Grand Prix',
      OfficialName: 'FORMULA 1 GP',
      Number: 20,
      Location: 'Mexico City',
      Country: { Key: 38, Code: 'MEX', Name: 'Mexico' },
      Circuit: { Key: 65, ShortName: 'Mexico City' },
      Sessions: [
        { Key: 11404, Type: 'Race', Name: 'Race', StartDate: '2026-11-01T14:00:00', EndDate: '2026-11-01T16:00:00', GmtOffset: '-06:00:00', Path: '2026/x/' },
        { Key: -1, Type: 'Other', Name: 'Skipped' },
      ],
    },
    { Name: 'No key' },
  ],
};

describe('calendar', () => {
  it('reads a season index, in UTC', () => {
    const { meetings, sessions } = fromSeasonIndex(INDEX, 2026);
    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({ meeting_key: 1298, round: 20, country_code: 'MEX', circuit_short_name: 'Mexico City', date_start: Date.UTC(2026, 10, 1, 20) });
    expect(sessions).toEqual([
      {
        session_key: 11404,
        meeting_key: 1298,
        session_name: 'Race',
        session_type: 'Race',
        year: 2026,
        date_start: Date.UTC(2026, 10, 1, 20),
        date_end: Date.UTC(2026, 10, 1, 22),
        gmt_offset: '-06:00:00',
        path: '2026/x/',
      },
    ]);
  });

  it('survives a broken index', () => {
    expect(fromSeasonIndex(null, 2026)).toEqual({ meetings: [], sessions: [] });
  });

  const session = (fields: Partial<SessionInfo>): SessionInfo => ({
    contentId: 1,
    title: 'Practice 1',
    type: 'practice',
    year: 2026,
    startMs: 100,
    endMs: 200,
    meetingKey: '1300',
    sessionKey: '11500',
    hasOnboards: false,
    series: 'FORMULA 1',
    status: 'upcoming',
    ...fields,
  });
  const event: EventInfo = { pageId: 1, name: 'FORMULA 1 LAS VEGAS GP', shortName: 'Las Vegas', round: 21, startMs: 50, endMs: 300, isTest: false };

  it('adds what F1 TV lists as coming up, skipping other series and anything without keys', () => {
    const { meetings, sessions } = fromUpcoming([session({}), session({ series: 'F2', sessionKey: '2' }), session({ sessionKey: null })], [event]);
    expect(sessions).toEqual([expect.objectContaining({ session_key: 11500, meeting_key: 1300, path: null })]);
    expect(meetings).toEqual([expect.objectContaining({ meeting_key: 1300, meeting_name: 'Las Vegas', round: 21 })]);
  });

  it('names a meeting from its event when a show the day before the event comes first', () => {
    const { meetings } = fromUpcoming([session({ sessionKey: '1', title: 'Weekend Warm-Up', startMs: 10 }), session({})], [event]);
    expect(meetings).toEqual([expect.objectContaining({ meeting_key: 1300, meeting_name: 'Las Vegas', round: 21, date_start: 50 })]);
  });

  it('prefers the earlier source, keeps old entries a refresh no longer lists, and sorts by time', () => {
    const fresh = fromSeasonIndex(INDEX, 2026);
    const old = { meetings: [{ ...fresh.meetings[0], meeting_name: 'Old name' }], sessions: [{ ...fresh.sessions[0], session_key: 1, date_start: 5 }] };
    const merged = mergeSchedule([fresh, old], 9);
    expect(merged.meetings[0].meeting_name).toBe('Mexico City Grand Prix');
    expect(merged.sessions.map((s) => s.session_key)).toEqual([1, 11404]);
    expect(merged.refreshedAt).toBe(9);
  });
});
