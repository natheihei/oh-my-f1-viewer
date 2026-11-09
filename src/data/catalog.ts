/**
 * What F1 TV offers: past, live and upcoming. Remembers every session it has listed, so one can be
 * opened later by its contentId alone.
 */
import { create } from 'zustand';
import type { EventInfo, LiveItem, SeasonInfo, SessionInfo } from '../../shared/api';

/** The first season the app supports. Earlier ones are on F1 TV, but nothing here is built for them. */
export const FIRST_SEASON = 2023;

/**
 * Every event from FIRST_SEASON on, loaded once at start. The agent gets it up front, so it can work
 * out which weekend the user means without looking it up. Failing to load is an error for the user
 * to see and retry: without it the agent can't find anything.
 */
export interface EventIndex {
  state: 'idle' | 'loading' | 'ready' | 'error';
  seasons: { year: number; events: EventInfo[] }[];
  error: string | null;
}

export const useEventIndex = create<EventIndex>(() => ({ state: 'idle', seasons: [], error: null }));

let indexLoad: Promise<EventIndex> | null = null;

function loadEventIndex(): Promise<EventIndex> {
  if (indexLoad) return indexLoad;
  useEventIndex.setState({ state: 'loading', error: null });
  indexLoad = (async () => {
    try {
      const all = await window.f1a.f1tv.seasons();
      const supported = all.filter((s) => s.year >= FIRST_SEASON).sort((a, b) => a.year - b.year);
      if (supported.length === 0) throw new Error(`F1 TV lists no season from ${FIRST_SEASON} on.`);
      const seasons = await Promise.all(supported.map(async (s) => ({ year: s.year, events: await window.f1a.f1tv.events(s.pageId) })));
      useEventIndex.setState({ state: 'ready', seasons, error: null });
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
      useEventIndex.setState({ state: 'error', error: message });
    } finally {
      indexLoad = null;
    }
    return useEventIndex.getState();
  })();
  return indexLoad;
}

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
  /** Loads the event index, or joins a load already under way. Never throws: the result says how it went. */
  loadIndex: loadEventIndex,

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
