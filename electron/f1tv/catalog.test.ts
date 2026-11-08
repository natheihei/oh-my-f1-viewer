import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { classifySessionType, fetchSchedule, parseChannels, parseEventsPage, parseSessionsPage } = await import('./catalog');
const { mkdtempSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const path = await import('node:path');

const stream = (channelId: number, title: string, extra: Record<string, unknown> = {}) => ({
  channelId,
  title,
  identifier: title,
  type: 'additional',
  ...extra,
});

describe('classifySessionType', () => {
  it.each([
    ['2026 São Paulo GP - Practice 3', 'practice'],
    ['2026 São Paulo GP - Qualifying', 'qualifying'],
    ['2026 São Paulo Grand Prix', 'race'],
    ['2026 Chinese GP - Sprint', 'sprint'],
    ['2026 Chinese GP - Sprint Qualifying', 'sprint-qualifying'],
    ['Pre-Qualifying Show - Brazil', 'show'],
    ['Post-Qualifying Show - Brazil', 'show'],
    ['Weekend Warm-Up - Brazil', 'show'],
    ['2025 São Paulo Grand Prix - F1 Kids', 'show'],
  ])('%s is %s', (title, type) => {
    expect(classifySessionType(title)).toBe(type);
  });
});

describe('parseChannels', () => {
  const container = {
    metadata: {
      contentId: 1000010420,
      title: 'Race',
      additionalStreams: [
        stream(1007, 'HAM', { type: 'obc', identifier: 'OBC', driverFirstName: 'Lewis', driverLastName: 'Hamilton', racingNumber: 44, teamName: 'Ferrari' }),
        stream(1025, 'INTERNATIONAL', { default: true, identifier: 'WIF' }),
        stream(1033, 'F1 LIVE', { identifier: 'PRES' }),
        stream(1004, 'DATA', { identifier: 'DATA' }),
        stream(1003, 'TRACKER', { identifier: 'TRACKER' }),
      ],
    },
  };

  it('exposes every channel, main feed first', () => {
    const channels = parseChannels(container, 1000010420);
    expect(channels.map((c) => [c.label, c.kind])).toEqual([
      ['INTERNATIONAL', 'main'],
      ['F1 LIVE', 'other'],
      ['DATA', 'data'],
      ['TRACKER', 'tracker'],
      ['HAM', 'onboard'],
    ]);
  });

  it('carries driver details for onboards', () => {
    const ham = parseChannels(container, 1000010420).find((c) => c.label === 'HAM');
    expect(ham).toMatchObject({ driverName: 'Lewis Hamilton', number: 44, team: 'Ferrari', id: '1000010420:1007' });
  });

  it('falls back to the base feed when a session has no additional streams', () => {
    const channels = parseChannels({ metadata: { contentId: 5, title: 'Show' } }, 5);
    expect(channels).toEqual([{ id: '5:0', contentId: 5, kind: 'main', label: 'Main', title: 'Show' }]);
    expect(channels[0].channelId).toBeUndefined();
  });
});

const page = (items: unknown[]) => [{ retrieveItems: { resultObj: { containers: items } } }];

describe('parseSessionsPage', () => {
  const session = (contentId: number, title: string, startMs: number, subtype = 'REPLAY') => ({
    title,
    metadata: {
      contentId,
      title,
      contentSubtype: subtype,
      emfAttributes: { VideoType: 'meetingSession', sessionStartDate: startMs, MeetingKey: '1298', Series: 'FORMULA 1', OBC: true },
    },
  });

  it('keeps only sessions of the requested season, oldest first', () => {
    const sessions = parseSessionsPage(
      page([
        session(2, '2026 GP - Qualifying', Date.UTC(2026, 9, 31)),
        session(1, '2026 GP - Practice 1', Date.UTC(2026, 9, 30)),
        session(3, '2025 Grand Prix', Date.UTC(2025, 9, 26)),
      ]),
      2026,
    );
    expect(sessions.map((s) => s.contentId)).toEqual([1, 2]);
    expect(sessions[0]).toMatchObject({ year: 2026, type: 'practice', meetingKey: '1298', hasOnboards: true });
  });

  it('marks live sessions and skips highlights', () => {
    const highlight = { title: 'Highlights', metadata: { contentId: 9, contentSubtype: 'HIGHLIGHTS', emfAttributes: {} } };
    const sessions = parseSessionsPage(page([session(1, '2026 Grand Prix', Date.UTC(2026, 10, 8), 'LIVE'), highlight]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('live');
  });
});

describe('parseEventsPage', () => {
  const event = (pageId: number, title: string, startMs: number) => ({
    title,
    actions: [{ key: 'onClick', uri: `/2.0/R/ENG/WEB_DASH/ALL/PAGE/${pageId}/x/2` }],
    metadata: { contentSubtype: 'MEETING', emfAttributes: { VideoType: 'meetings', Meeting_Name: title.replace('FORMULA 1 ', '') } },
    properties: [{ meeting_Start_Date: startMs, meeting_End_Date: startMs + 1, meeting_Number: 20 }],
  });

  it('includes future events, deduplicates, and sorts by date', () => {
    const later = Date.now() + 10 ** 10;
    const events = parseEventsPage(
      page([event(2, 'FORMULA 1 FUTURE GRAND PRIX', later), event(1, 'FORMULA 1 PAST GRAND PRIX', 1000), event(2, 'FORMULA 1 FUTURE GRAND PRIX', later)]),
    );
    expect(events.map((e) => e.pageId)).toEqual([1, 2]);
    expect(events[1].shortName).toBe('FUTURE GRAND PRIX');
  });

  it('leaves out other series', () => {
    expect(parseEventsPage(page([event(3, 'FORMULA 1 F2 GRAND PRIX', 1000)]))).toEqual([]);
  });
});

describe('fetchSchedule', () => {
  const row = { meeting_key: 1, session_key: 2, country_name: 'United States', location: 'Las Vegas', session_name: 'Practice 1', session_type: 'Practice', date_start: '2026-11-20T00:30:00+00:00', date_end: '2026-11-20T01:30:00+00:00' };
  const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const cacheFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'f1a-schedule-')), 'schedule.json');

  it('saves a good schedule', async () => {
    vi.stubGlobal('fetch', respond([row]));
    const file = cacheFile();
    const schedule = await fetchSchedule(2026, file);
    expect(schedule[0]).toMatchObject({ location: 'Las Vegas', name: 'Practice 1', sessionKey: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(schedule);
  });

  it('uses the saved copy when OpenF1 closes during a live session', async () => {
    const file = cacheFile();
    vi.stubGlobal('fetch', respond([row]));
    await fetchSchedule(2026, file);
    vi.stubGlobal('fetch', respond({ detail: 'Live F1 session in progress.' }, 401));
    expect((await fetchSchedule(2026, file))[0].location).toBe('Las Vegas');
  });

  it('treats a refusal as an error, not as an empty schedule', async () => {
    vi.stubGlobal('fetch', respond({ detail: 'Live F1 session in progress.' }));
    await expect(fetchSchedule(2026, cacheFile())).rejects.toThrow(/schedule is unavailable/);
  });
});
