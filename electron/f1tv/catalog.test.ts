import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { classifySessionType, eventsAhead, parseChannels, parseEventsPage, parseSessionsPage } = await import('./catalog');

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

describe('parseSessionsPage with a schedule section', () => {
  const entry = (contentId: number, title: string, startMs: number, subtype: string, extra: Record<string, unknown> = {}) => ({
    metadata: {
      contentId,
      title,
      contentSubtype: subtype,
      emfAttributes: { VideoType: 'meetingSession', sessionStartDate: startMs, sessionEndDate: startMs + 3_600_000, MeetingKey: '1300', MeetingSessionKey: String(contentId), Series: 'FORMULA 1', OBC: true, ...extra },
    },
  });
  const schedule = (events: unknown[]) => ({
    layout: 'interactive_schedule',
    retrieveItems: {
      resultObj: {
        containers: [
          { eventName: 'ALL', events },
          { eventName: 'FORMULA 1', events },
        ],
      },
    },
  });
  const P1 = Date.UTC(2026, 10, 20);

  it('reads future sessions, once each, soonest first', () => {
    const sessions = parseSessionsPage([
      schedule([entry(2, '2026 Las Vegas Grand Prix', P1 + 10 ** 8, 'LIVE_EVENT'), entry(1, '2026 Las Vegas GP - Practice 1', P1, 'LIVE_EVENT')]),
    ]);
    expect(sessions.map((s) => s.contentId)).toEqual([1, 2]);
    expect(sessions[0]).toMatchObject({ status: 'upcoming', type: 'practice', startMs: P1, sessionKey: '1', hasOnboards: true });
    expect(sessions[1].type).toBe('race');
  });

  it('maps each state F1 TV uses', () => {
    const sessions = parseSessionsPage([
      schedule([entry(1, 'a Practice 1', P1, 'REPLAY'), entry(2, 'a Qualifying', P1 + 1, 'LIVE'), entry(3, 'a Grand Prix', P1 + 2, 'LIVE_EVENT')]),
    ]);
    expect(sessions.map((s) => s.status)).toEqual(['replay', 'live', 'upcoming']);
  });

  it('adds trays to the schedule, which wins for sessions in both', () => {
    const tray = page([entry(1, 'tray copy', P1, 'REPLAY'), entry(9, '2026 GP - F1A Race 1', P1 + 1, 'REPLAY', { Series: 'F1 ACADEMY' })])[0];
    const sessions = parseSessionsPage([tray, schedule([entry(1, '2026 GP - Practice 1', P1, 'REPLAY')])]);
    expect(sessions.map((s) => [s.contentId, s.title])).toEqual([
      [1, '2026 GP - Practice 1'],
      [9, '2026 GP - F1A Race 1'],
    ]);
    expect(sessions[1].series).toBe('F1 ACADEMY');
  });

  it('drops an end time that comes before the start', () => {
    const [session] = parseSessionsPage([schedule([entry(1, 'Post-Race Show', P1, 'LIVE_EVENT', { sessionEndDate: P1 - 1000 })])]);
    expect(session.endMs).toBeNull();
    expect(session.startMs).toBe(P1);
  });

  it('reads 2018, whose sessions only appear in the weekend tray, without a video type', () => {
    const replay = { metadata: { contentId: 7, title: '2018 Australian Grand Prix', contentSubtype: 'REPLAY', season: 2018, emfAttributes: {} } };
    const highlight = { metadata: { contentId: 8, title: 'Highlights', contentSubtype: 'HIGHLIGHTS', season: 2018, emfAttributes: {} } };
    const sessions = parseSessionsPage(
      [
        { metadata: { label: 'Weekend Sessions' }, retrieveItems: { resultObj: { containers: [replay, highlight] } } },
        { metadata: { label: 'From The Archive' }, retrieveItems: { resultObj: { containers: [{ metadata: { contentId: 6, title: 'x', contentSubtype: 'REPLAY', season: 2018, emfAttributes: {} } }] } } },
      ],
      2018,
    );
    expect(sessions.map((s) => s.contentId)).toEqual([7]);
    expect(sessions[0]).toMatchObject({ year: 2018, series: 'FORMULA 1', status: 'replay', type: 'race' });
  });
});

describe('eventsAhead', () => {
  const event = (pageId: number, startMs: number, endMs: number, isTest = false) => ({ pageId, name: '', shortName: '', round: 0, startMs, endMs, isTest });

  it('includes the event in progress, then the next, and nothing further', () => {
    const events = [event(1, 0, 900), event(2, 950, 1100), event(3, 2000, 2100), event(4, 3000, 3100)];
    expect(eventsAhead(events, 1000).map((e) => e.pageId)).toEqual([2, 3]);
  });

  it('skips tests, and is empty after the last event', () => {
    expect(eventsAhead([event(1, 2000, 2100, true), event(2, 3000, 3100)], 1000).map((e) => e.pageId)).toEqual([2]);
    expect(eventsAhead([event(1, 0, 900)], 1000)).toEqual([]);
  });
});
