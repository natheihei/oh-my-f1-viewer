/**
 * Runs the agent's tool calls against the app. Results are short and go back to the model; nothing
 * returned here may reveal how a session turned out, only what exists and what is on screen.
 */
import type { AgentToolCall, Channel, EventInfo, SessionInfo } from '../../shared/api';
import { videoSpec } from '../components/VideoTile';
import { sessionControl, useSession } from '../data/session';
import { allTiles, type ComponentSpec, type GroupNode, type LayoutState } from '../layout/model';
import { layout } from '../layout/store';
import { openViewingSession, startCountdown, useCountdown } from '../shell/viewing';

const knownSessions = new Map<number, SessionInfo>();

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const isInternational = (c: Channel) => normalize(c.label) === 'international';
const CHANNEL_ALIASES: Record<string, (c: Channel) => boolean> = {
  main: (c) => c.kind === 'main',
  'main feed': (c) => c.kind === 'main',
  'main broadcast': (c) => c.kind === 'main',
  broadcast: (c) => c.kind === 'main',
  // The clean international feed, which F1 TV may not mark as its default channel.
  'world feed': isInternational,
  'international feed': isInternational,
  data: (c) => c.kind === 'data',
  'data channel': (c) => c.kind === 'data',
  tracker: (c) => c.kind === 'tracker',
  'driver tracker': (c) => c.kind === 'tracker',
};

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** Misspelled names: the closest driver name within a typo or two, if exactly one is that close. */
function closestDriver(channels: Channel[], needle: string): Channel | undefined {
  if (needle.length < 4) return undefined;
  const allowed = needle.length >= 7 ? 2 : 1;
  const close = channels.filter((c) =>
    normalize(c.driverName ?? '')
      .split(/\s+/)
      .some((name) => name.length >= 4 && editDistance(name, needle) <= allowed),
  );
  return close.length === 1 ? close[0] : undefined;
}

/** Matches a driver code, surname, first name, car number, channel name, or a near miss of a name. */
export function resolveChannel(channels: Channel[], ref: string): Channel | null {
  const needle = normalize(ref);
  if (!needle) return null;
  const alias = CHANNEL_ALIASES[needle];
  if (alias) {
    const hit = channels.find(alias);
    if (hit) return hit;
  }
  return (
    channels.find((c) => normalize(c.label) === needle || normalize(c.title) === needle) ??
    channels.find((c) => c.number != null && String(c.number) === needle) ??
    channels.find((c) => c.driverName && normalize(c.driverName) === needle) ??
    channels.find((c) => c.driverName && normalize(c.driverName).split(/\s+/).includes(needle)) ??
    (needle.length >= 3
      ? channels.find(
          (c) =>
            (c.driverName && normalize(c.driverName).includes(needle)) ||
            normalize(c.label).startsWith(needle) ||
            normalize(c.title).includes(needle),
        )
      : undefined) ??
    closestDriver(channels, needle) ??
    null
  );
}

function resolveAll(refs: unknown): { channels: Channel[]; missing: string[] } {
  const available = useSession.getState().channels;
  const channels: Channel[] = [];
  const missing: string[] = [];
  for (const ref of Array.isArray(refs) ? refs : [refs]) {
    const hit = resolveChannel(available, String(ref));
    if (!hit) missing.push(String(ref));
    else if (!channels.includes(hit)) channels.push(hit);
  }
  return { channels, missing };
}

function specOf(channel: Channel): ComponentSpec {
  return videoSpec(channel.id, channel.label);
}

function isoDate(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString().slice(0, 16) + 'Z' : null;
}

async function listEvents(year: number): Promise<unknown> {
  const seasons = await window.f1a.f1tv.seasons();
  const season = seasons.find((s) => s.year === year);
  if (!season) return { error: `F1 TV has no ${year} season. It has: ${seasons.map((s) => s.year).join(', ')}` };
  const events: EventInfo[] = await window.f1a.f1tv.events(season.pageId);
  return events.map((e) => ({
    pageId: e.pageId,
    name: e.shortName || e.name,
    officialName: e.name,
    round: e.round,
    startsOn: isoDate(e.startMs),
    isTest: e.isTest,
  }));
}

async function listSessions(pageId: number, year: number): Promise<unknown> {
  const all = await window.f1a.f1tv.sessions(pageId, year);
  for (const s of all) knownSessions.set(s.contentId, s);
  // Event pages also carry F1 Academy and similar, whose races would read as "the race".
  const formula1 = all.filter((s) => s.series === 'FORMULA 1');
  const sessions = formula1.length ? formula1 : all;
  return sessions.map((s) => ({
    contentId: s.contentId,
    title: s.title,
    type: s.type,
    status: s.status,
    startedAt: isoDate(s.startMs),
  }));
}

async function listLive(): Promise<unknown> {
  const items = await window.f1a.f1tv.liveNow();
  const now = Date.now();
  for (const i of items) {
    knownSessions.set(i.contentId, {
      contentId: i.contentId,
      title: i.title,
      type: 'other',
      year: new Date(now).getUTCFullYear(),
      startMs: null,
      endMs: null,
      meetingKey: i.meetingKey ?? null,
      sessionKey: i.sessionKey ?? null,
      hasOnboards: true,
      series: 'FORMULA 1',
      status: 'live',
    });
  }
  return items.map((i) => ({ contentId: i.contentId, title: i.title }));
}

async function listUpcoming(): Promise<unknown> {
  const sessions = (await window.f1a.f1tv.upcoming()).filter((s) => s.series === 'FORMULA 1');
  for (const s of sessions) knownSessions.set(s.contentId, s);
  return sessions.slice(0, 16).map((s) => ({
    contentId: s.contentId,
    title: s.title,
    type: s.type,
    startsAt: isoDate(s.startMs),
  }));
}

/** A listed session can have gone on air since. */
async function currentStatus(session: SessionInfo): Promise<SessionInfo> {
  if (session.status !== 'upcoming') return session;
  const live = await window.f1a.f1tv.liveNow();
  return live.some((i) => i.contentId === session.contentId) ? { ...session, status: 'live' } : session;
}

async function loadSession(contentId: number, title: string, fromStart: boolean): Promise<unknown> {
  const year = Number(title.match(/\b(20\d{2})\b/)?.[1]) || new Date().getUTCFullYear();
  const known = knownSessions.get(contentId);
  const session = await currentStatus(
    known ?? {
      contentId,
      title,
      type: 'other',
      year,
      startMs: null,
      endMs: null,
      meetingKey: null,
      sessionKey: null,
      hasOnboards: true,
      series: 'FORMULA 1',
      status: 'replay',
    },
  );
  if (session.status === 'upcoming') {
    throw new Error(`${session.title} hasn't started. Offer wait_for_session instead.`);
  }
  const channels = await openViewingSession(session, { fromStart });
  return {
    opened: session.title,
    playingFrom: session.status === 'live' && !fromStart ? 'live edge' : 'start',
    streams: channels.map((c) => c.label),
  };
}

function onScreen(): { key: string; label: string }[] {
  return layout.tiles().map((t) => ({ key: t.component.key, label: t.component.label }));
}

function listStreams(): unknown {
  const shown = new Set(onScreen().map((t) => t.key));
  return useSession.getState().channels.map((c) => ({
    name: c.label,
    kind: c.kind,
    driver: c.driverName,
    team: c.team,
    number: c.number,
    onScreen: shown.has(c.id),
  }));
}

function needSession(): void {
  if (!useSession.getState().session) throw new Error('No session is open.');
}

function missingNote(missing: string[]): string {
  return missing.length ? ` Not found: ${missing.join(', ')}. Use list_streams to see the options.` : '';
}

/** Returns the model-facing result text; throws on failure. */
export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'list_events':
      return JSON.stringify(await listEvents(Number(args.year)));
    case 'list_sessions':
      return JSON.stringify(await listSessions(Number(args.pageId), Number(args.year)));
    case 'list_live':
      return JSON.stringify(await listLive());
    case 'list_upcoming':
      return JSON.stringify(await listUpcoming());
    case 'load_session':
      return JSON.stringify(await loadSession(Number(args.contentId), String(args.title), args.fromStart === true));
    case 'wait_for_session': {
      const session = knownSessions.get(Number(args.contentId));
      if (!session) throw new Error('Unknown contentId. Get it from list_upcoming or list_sessions first.');
      if (session.status !== 'upcoming') throw new Error(`${session.title} isn't upcoming. Use load_session.`);
      startCountdown(session, (live) => void openViewingSession(live));
      return 'Countdown showing. It starts by itself when F1 TV goes live.';
    }
    case 'list_streams':
      needSession();
      return JSON.stringify(listStreams());
    case 'add_streams': {
      needSession();
      const { channels, missing } = resolveAll(args.streams);
      for (const c of channels) layout.add(specOf(c));
      if (channels.length === 0) throw new Error(`No matching streams.${missingNote(missing)}`);
      return `On screen: ${channels.map((c) => c.label).join(', ')}.${missingNote(missing)}`;
    }
    case 'remove_streams': {
      needSession();
      const { channels, missing } = resolveAll(args.streams);
      for (const c of channels) layout.remove(c.id);
      return `Removed: ${channels.map((c) => c.label).join(', ') || 'nothing'}.${missingNote(missing)}`;
    }
    case 'create_group': {
      needSession();
      const { channels, missing } = resolveAll(args.streams);
      if (channels.length < 2) throw new Error(`A group needs at least two streams.${missingNote(missing)}`);
      const id = layout.group(channels.map(specOf), args.title ? String(args.title) : undefined);
      return `Group ${id} showing ${channels.map((c) => c.label).join(', ')}.${missingNote(missing)}`;
    }
    case 'close_group': {
      needSession();
      const ref = String(args.group);
      const removed = layout.closeGroup(groupRef(ref));
      if (!removed) throw new Error(`No group matches "${ref}".`);
      return `Closed group: ${removed.map((c) => c.label).join(', ')}.`;
    }
    case 'ungroup': {
      needSession();
      const ref = String(args.group);
      if (!layout.ungroup(groupRef(ref))) throw new Error(`No group matches "${ref}".`);
      return 'Group dissolved; its streams stay on screen.';
    }
    case 'focus_stream': {
      needSession();
      const ref = String(args.stream);
      const channel = resolveChannel(useSession.getState().channels, ref);
      const ok = (channel && layout.focus(channel.id)) || layout.focus(groupRef(ref));
      if (!ok) throw new Error(`"${ref}" is not on screen.`);
      return 'Done.';
    }
    case 'reset_layout':
      layout.reset();
      return 'Layout reset.';
    case 'set_audio': {
      needSession();
      const ref = String(args.stream);
      if (normalize(ref) === 'none') {
        sessionControl.setAudio(null);
        return 'All streams muted.';
      }
      const channel = resolveChannel(useSession.getState().channels, ref);
      if (!channel || !layout.has(channel.id)) throw new Error(`"${ref}" is not on screen.`);
      sessionControl.setAudio(channel.id);
      return `Audio is now ${channel.label}.`;
    }
    case 'play':
      needSession();
      sessionControl.play();
      return 'Playing.';
    case 'pause':
      needSession();
      sessionControl.pause();
      return 'Paused.';
    case 'seek_to_start':
      needSession();
      sessionControl.seekToStart();
      return 'Back at the start.';
    case 'seek_back': {
      needSession();
      if (useSession.getState().clock.end <= 0) throw new Error('Nothing is playing yet, so there is nothing to rewind.');
      const seconds = Math.abs(Number(args.seconds));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be positive.');
      sessionControl.seekBy(-seconds);
      return `Back ${seconds}s.`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** A group can be named by a stream inside it, so translate stream names to their channel key. */
function groupRef(ref: string): string {
  const channel = resolveChannel(useSession.getState().channels, ref);
  return channel && layout.has(channel.id) ? channel.id : ref;
}

function describeLayout(state: LayoutState): string {
  if (state.nodes.length === 0) return 'nothing';
  return state.nodes
    .map((n) => (n.kind === 'tile' ? n.component.label : `group "${(n as GroupNode).title}" [${n.children.map((c) => c.component.label).join(', ')}]`))
    .join('; ');
}

function formatClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The state block sent with each user message. Contains nothing about how the race goes. */
export function describeAppState(): string {
  const { session, audioChannelId, channels, clock, streams } = useSession.getState();
  const countdown = useCountdown.getState().countdown;
  const lines = [`now: ${new Date().toISOString().slice(0, 16)}Z`];
  if (countdown) lines.push(`countdown running for: ${countdown.title}`);
  if (!session) {
    lines.push('session: none open');
    return lines.join('\n');
  }
  const state = layout.snapshot();
  const audio = channels.find((c) => c.id === audioChannelId)?.label ?? 'muted';
  const failed = allTiles(state)
    .filter((t) => streams[t.component.key]?.status === 'error')
    .map((t) => `${t.component.label}: ${streams[t.component.key]?.error}`);
  lines.push(
    `session: ${session.title} (${session.status})`,
    `playback: ${clock.playing ? 'playing' : 'paused'} at ${formatClock(clock.timeSec)}`,
    `on screen: ${describeLayout(state)}`,
    `audio: ${audio}`,
  );
  if (failed.length) lines.push(`failed streams: ${failed.join('; ')}`);
  return lines.join('\n');
}

export async function handleToolCall(call: AgentToolCall): Promise<void> {
  try {
    const content = await runTool(call.name, call.args);
    window.f1a.ai.toolResult({ callId: call.callId, ok: true, content });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    window.f1a.ai.toolResult({
      callId: call.callId,
      ok: false,
      content: message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ''),
    });
  }
}
