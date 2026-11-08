/**
 * Turns F1 TV's nested page containers into the flat lists the app works with. F1OpenViewer's
 * catalog module hides future events and the extra channels, so these views are built here on
 * top of its client: the data layer needs every channel, and session times for countdowns.
 */
import { promises as fsp } from 'node:fs';
import type {
  Channel,
  ChannelKind,
  EventInfo,
  ScheduledSession,
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

export function parseSessionsPage(page: any[], year?: number): SessionInfo[] {
  const out: SessionInfo[] = [];
  const seen = new Set<number>();
  for (const s of containersOf(page)) {
    const meta = s.metadata ?? {};
    const emf = meta.emfAttributes ?? {};
    const contentId = Number(meta.contentId);
    if (!contentId || seen.has(contentId)) continue;
    if (emf.VideoType !== 'meetingSession') continue;
    const subtype = String(meta.contentSubtype ?? '').toUpperCase();
    if (subtype !== 'REPLAY' && subtype !== 'LIVE') continue;
    const startMs = Number(emf.sessionStartDate) || null;
    const sessionYear = startMs ? new Date(startMs).getUTCFullYear() : Number(meta.season) || 0;
    // Event pages also list the same Grand Prix from earlier seasons.
    if (year && sessionYear && sessionYear !== year) continue;
    seen.add(contentId);
    const title = String(s.title ?? meta.title ?? '').trim();
    out.push({
      contentId,
      title,
      type: classifySessionType(title),
      year: sessionYear,
      startMs,
      endMs: Number(emf.sessionEndDate) || null,
      meetingKey: emf.MeetingKey ? String(emf.MeetingKey) : null,
      sessionKey: emf.SessionKey || emf.MeetingSessionKey ? String(emf.SessionKey || emf.MeetingSessionKey) : null,
      hasOnboards: emf.OBC === true || emf.OBC === 'true',
      series: String(emf.Series ?? 'FORMULA 1'),
      status: subtype === 'LIVE' ? 'live' : 'replay',
    });
  }
  return out.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
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

/**
 * Exact future session times. F1 TV only lists an event's sessions shortly before they run, so
 * upcoming sessions come from OpenF1; F1 TV's live-now list decides when playback can actually start.
 * OpenF1 closes its free API while any session is live, so the last good copy is kept on disk.
 */
export async function fetchSchedule(year: number, cacheFile?: string): Promise<ScheduledSession[]> {
  try {
    const res = await fetch(`https://api.openf1.org/v1/sessions?year=${encodeURIComponent(year)}`, {
      headers: { 'User-Agent': 'f1a', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const rows = (await res.json()) as any;
    if (!res.ok || !Array.isArray(rows)) throw new Error(`HTTP ${res.status}`);
    const schedule = parseSchedule(rows);
    if (cacheFile) await fsp.writeFile(cacheFile, JSON.stringify(schedule)).catch(() => {});
    return schedule;
  } catch (e) {
    const cached = cacheFile ? await fsp.readFile(cacheFile, 'utf8').catch(() => null) : null;
    if (cached) return JSON.parse(cached) as ScheduledSession[];
    throw new Error(`The session schedule is unavailable right now. OpenF1 closes it while a session is live. (${(e as Error).message})`);
  }
}

export function parseSchedule(rows: any[]): ScheduledSession[] {
  return rows
    .map((r) => ({
      meetingKey: Number(r.meeting_key),
      sessionKey: Number(r.session_key),
      country: String(r.country_name ?? ''),
      location: String(r.location ?? ''),
      name: String(r.session_name ?? ''),
      type: String(r.session_type ?? ''),
      startMs: Date.parse(r.date_start),
      endMs: Date.parse(r.date_end),
    }))
    .filter((r) => Number.isFinite(r.startMs))
    .sort((a, b) => a.startMs - b.startMs);
}
