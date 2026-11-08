/**
 * What F1 TV offers: past, live and upcoming. Remembers every session it has listed, so one can be
 * opened later by its contentId alone.
 */
import type { EventInfo, LiveItem, SeasonInfo, SessionInfo } from '../../shared/api';

const known = new Map<number, SessionInfo>();

function remember(sessions: SessionInfo[]): void {
  for (const s of sessions) known.set(s.contentId, s);
}

function liveToSession(item: LiveItem, now: number): SessionInfo {
  return {
    contentId: item.contentId,
    title: item.title,
    type: 'other',
    year: new Date(now).getUTCFullYear(),
    startMs: null,
    endMs: null,
    meetingKey: item.meetingKey ?? null,
    sessionKey: item.sessionKey ?? null,
    hasOnboards: true,
    series: 'FORMULA 1',
    status: 'live',
  };
}

export const catalog = {
  seasons: (): Promise<SeasonInfo[]> => window.f1a.f1tv.seasons(),

  async events(year: number): Promise<EventInfo[]> {
    const seasons = await window.f1a.f1tv.seasons();
    const season = seasons.find((s) => s.year === year);
    if (!season) throw new Error(`F1 TV has no ${year} season. It has: ${seasons.map((s) => s.year).join(', ')}`);
    return window.f1a.f1tv.events(season.pageId);
  },

  /** Event pages also carry F1 Academy and similar, whose races would read as "the race". */
  async sessions(pageId: number, year: number): Promise<SessionInfo[]> {
    const all = await window.f1a.f1tv.sessions(pageId, year);
    remember(all);
    const formula1 = all.filter((s) => s.series === 'FORMULA 1');
    return formula1.length ? formula1 : all;
  },

  /** The live list, without remembering it. Cheap enough to poll. */
  liveNow: (): Promise<LiveItem[]> => window.f1a.f1tv.liveNow(),

  async live(): Promise<LiveItem[]> {
    const items = await window.f1a.f1tv.liveNow();
    const now = Date.now();
    remember(items.map((i) => liveToSession(i, now)));
    return items;
  },

  async upcoming(): Promise<SessionInfo[]> {
    const sessions = (await window.f1a.f1tv.upcoming()).filter((s) => s.series === 'FORMULA 1');
    remember(sessions);
    return sessions;
  },

  known: (contentId: number): SessionInfo | undefined => known.get(contentId),

  /**
   * The session behind a contentId, with its status as of now, since a listed session can have gone
   * on air since. One that was never listed is assumed to be a replay.
   */
  async resolve(contentId: number, title?: string): Promise<SessionInfo> {
    const year = Number(title?.match(/\b(20\d{2})\b/)?.[1]) || new Date().getUTCFullYear();
    const session: SessionInfo = known.get(contentId) ?? {
      contentId,
      title: title ?? String(contentId),
      type: 'other',
      year,
      startMs: null,
      endMs: null,
      meetingKey: null,
      sessionKey: null,
      hasOnboards: true,
      series: 'FORMULA 1',
      status: 'replay',
    };
    if (session.status !== 'upcoming') return session;
    const live = await window.f1a.f1tv.liveNow();
    return live.some((i) => i.contentId === contentId) ? { ...session, status: 'live' } : session;
  },
};
