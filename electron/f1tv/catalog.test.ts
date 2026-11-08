import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { classifySessionType, parseChannels, parseEventsPage, parseSessionsPage } = await import('./catalog');

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
