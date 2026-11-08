/**
 * Turns F1 TV's nested page containers into the flat lists the app works with. F1 TV is the only
 * source of what exists and when: past, live and future. F1OpenViewer's catalog module hides future
 * events and the extra channels, so these views are built here on top of its client.
 */
import type {
  Channel,
  ChannelKind,
  EventInfo,
  SeasonInfo,
  SessionInfo,
  SessionType,
} from '../../shared/api';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const client = require('../vendor/f1ov/f1tvClient');
const vendorCatalog = require('../vendor/f1ov/f1tvCatalog');

function containersOf(page: any[]): any[] {
  return page.flatMap((c) => c?.retrieveItems?.resultObj?.containers ?? []);
}

export function classifySessionType(title: string): SessionType {
  const t = title.toLowerCase();
  if (/\b(pre|post)[\s-]|\bshow\b|warm-?up|\bkids\b/.test(t)) return 'show';
  if (/sprint\s*(qualifying|shootout)/.test(t)) return 'sprint-qualifying';
  if (/sprint/.test(t)) return 'sprint';
  if (/qualifying/.test(t)) return 'qualifying';
  if (/practice|\bfp[123]\b/.test(t)) return 'practice';
  if (/grand prix|\brace\b/.test(t)) return 'race';
  return 'other';
}

export function parseEventsPage(page: any[]): EventInfo[] {
  const byPage = new Map<number, EventInfo>();
  for (const s of containersOf(page)) {
    const action = s.actions?.find((a: any) => a.key === 'onClick');
    const pageId = Number(action?.uri?.match(/\/PAGE\/(\d+)\//)?.[1]);
    if (!pageId || byPage.has(pageId)) continue;
    const meta = s.metadata ?? {};
    const emf = meta.emfAttributes ?? {};
    const props = s.properties?.[0] ?? {};
    const name = String(s.title ?? meta.title ?? '').trim();
    const upper = name.toUpperCase();
    const isF1 =
      (upper.includes('GRAND PRIX') || upper.includes('FORMULA 1') || emf.VideoType === 'meetings' || meta.contentSubtype === 'MEETING') &&
      !upper.includes(' F2 ') &&
      !upper.includes(' F3 ');
    if (!isF1) continue;
    const startMs = Number(props.meeting_Start_Date ?? props.meeting_start_date ?? 0);
    byPage.set(pageId, {
      pageId,
      name,
      shortName: String(emf.Meeting_Name ?? emf.Global_Meeting_Name ?? name).trim(),
      round: Number(props.meeting_Number ?? emf.Meeting_Number ?? 0),
      startMs,
      endMs: Number(props.meeting_End_Date ?? props.meeting_end_date ?? 0),
      isTest: /test/i.test(name),
    });
  }
  return [...byPage.values()].sort((a, b) => a.startMs - b.startMs);
}

function sessionStatus(subtype: string): SessionInfo['status'] | null {
  if (subtype === 'REPLAY') return 'replay';
  if (subtype === 'LIVE') return 'live';
  if (subtype === 'LIVE_EVENT') return 'upcoming';
  return null;
}

function toSession(entry: any, year?: number): SessionInfo | null {
  const meta = entry.metadata ?? {};
  const emf = meta.emfAttributes ?? {};
  const contentId = Number(meta.contentId);
  const status = sessionStatus(String(meta.contentSubtype ?? '').toUpperCase());
  if (!contentId || !status) return null;
  const startMs = Number(emf.sessionStartDate) || null;
  const sessionYear = startMs ? new Date(startMs).getUTCFullYear() : Number(meta.season ?? meta.year) || 0;
  // Event pages also list the same Grand Prix from earlier seasons.
  if (year && sessionYear && sessionYear !== year) return null;
  const endMs = Number(emf.sessionEndDate) || null;
  const title = String(entry.title ?? meta.title ?? '').trim();
  const sessionKey = emf.SessionKey || emf.MeetingSessionKey;
  return {
    contentId,
    title,
    type: classifySessionType(title),
    year: sessionYear,
    startMs,
    // F1 TV has some end times before their start, e.g. a post-race show ending the same morning.
    endMs: endMs && startMs && endMs < startMs ? null : endMs,
    meetingKey: emf.MeetingKey ? String(emf.MeetingKey) : null,
    sessionKey: sessionKey ? String(sessionKey) : null,
    hasOnboards: emf.OBC === true || emf.OBC === 'true',
    series: String(emf.Series || 'FORMULA 1'),
    status,
  };
}

/**
 * Every session on an event page. F1 TV keeps them in two places:
 *  - an `interactive_schedule` section, on events from 2024 on: the whole weekend including sessions
 *    that haven't happened, grouped by series with an "ALL" group, and the only place with those;
 *  - replay trays, on every season back to 2018, which also carry support series and earlier years.
 * Older events have only the trays, and 2018 sessions lack the VideoType later seasons carry, so
 * there they're recognised by the tray they sit in.
 */
export function parseSessionsPage(page: any[], year?: number): SessionInfo[] {
  const byId = new Map<number, SessionInfo>();
  const add = (entry: any) => {
    const session = toSession(entry, year);
    if (session && !byId.has(session.contentId)) byId.set(session.contentId, session);
  };
  for (const section of page) {
    if (section?.layout !== 'interactive_schedule') continue;
    for (const group of section.retrieveItems?.resultObj?.containers ?? []) {
      for (const entry of group.events ?? []) add(entry);
    }
  }
  for (const section of page) {
    if (section?.layout === 'interactive_schedule') continue;
    const inWeekendTray = /weekend sessions/i.test(String(section?.metadata?.label ?? section?.metadata?.title ?? ''));
    for (const entry of section?.retrieveItems?.resultObj?.containers ?? []) {
      const videoType = entry.metadata?.emfAttributes?.VideoType;
      if (videoType === 'meetingSession' || (inWeekendTray && !videoType)) add(entry);
    }
  }
  return [...byId.values()].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
}

function channelKind(stream: any): ChannelKind {
  const identifier = String(stream.identifier ?? '').toUpperCase();
  const type = String(stream.type ?? '').toLowerCase();
  const title = String(stream.title ?? stream.reportingName ?? '').toUpperCase();
  if (type === 'obc' || identifier === 'OBC' || type.includes('onboard')) return 'onboard';
  if (identifier === 'DATA' || title === 'DATA' || type.includes('data')) return 'data';
  if (identifier === 'TRACKER' || title === 'TRACKER') return 'tracker';
  return 'other';
}

/** Every stream of a session: the world feed, onboards, data, tracker and any other channels. */
export function parseChannels(container: any, contentId: number): Channel[] {
  const meta = container?.metadata ?? {};
  const additional: any[] = Array.isArray(meta.additionalStreams) ? meta.additionalStreams : [];
  const mainPick = vendorCatalog.pickMainChannelStream(additional);
  const id = meta.contentId ?? contentId;

  const channels: Channel[] = [];
  for (const s of additional) {
    if (!s.channelId) continue;
    const isMain = mainPick && s.channelId === mainPick.channelId;
    const kind: ChannelKind = isMain ? 'main' : channelKind(s);
    const title = String(s.title ?? s.reportingName ?? '').trim();
    const driverName =
      s.driverFirstName || s.driverLastName
        ? [s.driverFirstName, s.driverLastName].filter(Boolean).join(' ')
        : undefined;
    channels.push({
      id: `${id}:${s.channelId}`,
      contentId: Number(id),
      channelId: Number(s.channelId),
      kind,
      label: kind === 'onboard' ? title || `#${s.racingNumber ?? ''}` : title || 'Feed',
      title,
      driverName,
      driverCode: kind === 'onboard' ? title || undefined : undefined,
      team: s.teamName || undefined,
      number: s.racingNumber != null ? Number(s.racingNumber) : undefined,
    });
  }
  // Sessions without additional streams (practice shows, older seasons) only have the base feed.
  if (!channels.some((c) => c.kind === 'main')) {
    channels.unshift({
      id: `${id}:0`,
      contentId: Number(id),
      kind: 'main',
      label: 'Main',
      title: String(meta.title ?? 'Main feed'),
    });
  }
  const order: ChannelKind[] = ['main', 'other', 'data', 'tracker', 'onboard'];
  return channels.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export async function listEvents(seasonPageId: number): Promise<EventInfo[]> {
  return parseEventsPage(await client.fetchPage(seasonPageId));
}

export async function listSessions(eventPageId: number, year?: number): Promise<SessionInfo[]> {
  return parseSessionsPage(await client.fetchPage(eventPageId), year);
}

export async function listChannels(contentId: number): Promise<Channel[]> {
  const { container } = await vendorCatalog.getContentVideo(contentId);
  return parseChannels(container, contentId);
}

/** How many events ahead to look, which covers any gap in the calendar. */
const UPCOMING_EVENTS = 2;

/** Events that still have sessions to come, soonest first. */
export function eventsAhead(events: EventInfo[], nowMs: number): EventInfo[] {
  return events.filter((e) => !e.isTest && e.endMs > nowMs).slice(0, UPCOMING_EVENTS);
}

/** Sessions that haven't started, soonest first. Nothing past this season is published yet. */
export async function listUpcoming(seasons: SeasonInfo[], nowMs = Date.now()): Promise<SessionInfo[]> {
  const season = seasons.find((s) => s.year === new Date(nowMs).getUTCFullYear());
  if (!season) return [];
  const ahead = eventsAhead(await listEvents(season.pageId), nowMs);
  const sessions = (await Promise.all(ahead.map((e) => listSessions(e.pageId, season.year)))).flat();
  return sessions
    .filter((s) => s.status === 'upcoming' && (s.startMs ?? 0) > nowMs)
    .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
}
