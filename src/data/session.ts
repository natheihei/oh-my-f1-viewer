/**
 * The open viewing session and its clock: the only source of "now" in the app. Upper layers
 * acquire streams, read the clock, and issue play/pause/seek here. They never touch a stream's
 * time directly, and a stream is only reported ready once it is aligned to this clock.
 */
import { create } from 'zustand';
import type { Channel, SessionInfo } from '../../shared/api';
import { joinPoint } from './join';
import { LIVE_EDGE_OFFSET_SEC, LIVE_START_MARGIN_SEC, StreamHandle, type StreamStatus } from './stream';
import { isStalled, pickReference, syncTick, type SyncEntry } from './syncEngine';
import { openSessionData, type SessionDataHandle } from './sessionData';
import { normalizeVolume, toggledVolume } from './volume';

const TICK_MS = 200;
/** Spacing between seeks, so all streams don't flush their buffers at the same instant. */
const SEEK_STAGGER_MS = 60;
/**
 * Streams start one at a time, each once the last has media or this long has passed. Starting
 * several at once is a burst of segment requests, and bursts are what F1's CDN seems to punish.
 */
const START_STAGGER_MAX_MS = 6000;

export interface ClockState {
  timeSec: number;
  playing: boolean;
  buffering: boolean;
  live: boolean;
  /** Seekable range of the timeline, once any stream has reported one. */
  start: number;
  end: number;
  atLiveEdge: boolean;
  wallClockMs: number | null;
}

export interface StreamView {
  channelId: string;
  status: StreamStatus;
  error: string | null;
}

export interface SessionState {
  session: SessionInfo | null;
  channels: Channel[];
  /** Why opening failed, if it did. */
  error: string | null;
  streams: Record<string, StreamView>;
  audioChannelId: string | null;
  /** Master level from 0 to 1, whichever feed is audible. It outlives any one session. */
  volume: number;
  clock: ClockState;
}

const IDLE_CLOCK: ClockState = {
  timeSec: 0,
  playing: false,
  buffering: false,
  live: false,
  start: 0,
  end: 0,
  atLiveEdge: false,
  wallClockMs: null,
};

/** What opening and closing a session reset. */
const INITIAL: Omit<SessionState, 'volume'> = {
  session: null,
  channels: [],
  error: null,
  streams: {},
  audioChannelId: null,
  clock: IDLE_CLOCK,
};

export const useSession = create<SessionState>(() => ({ ...INITIAL, volume: 1 }));

/** The level the mute icon goes back to. */
let lastHeardVolume = 1;

const LIVE_EDGE_TOLERANCE_SEC = 15;

export interface HoldOptions {
  /** A hold that shows the feed without ever making it audible, like a preview. */
  quiet?: boolean;
}

class SessionRuntime {
  private readonly handles = new Map<string, StreamHandle>();
  private readonly held = new Set<string>();
  private readonly holds = new Map<string, { loud: number; quiet: number }>();
  private readonly pendingRelease = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private referenceId: string | null = null;
  private wantPlaying = true;
  private virtualTime = 0;
  private virtualAt = performance.now();
  /** The clock holds at the start until the first stream has media to show. */
  private started = false;
  private readonly live: boolean;
  private sessionData: SessionDataHandle | null = null;
  private startQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly session: SessionInfo,
    private fromStart: boolean,
  ) {
    this.live = session.status === 'live';
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.sessionData = openSessionData(session, this.live);
  }

  private channelOf(channelId: string): Channel | undefined {
    return useSession.getState().channels.find((c) => c.id === channelId);
  }

  private publishStreams(): void {
    const streams: Record<string, StreamView> = {};
    for (const [id, h] of this.handles) streams[id] = { channelId: id, status: h.status, error: h.error };
    useSession.setState({ streams });
  }

  /**
   * Takes a hold on a feed's stream, starting it if nobody holds it. There is one stream and one
   * video element per feed: a second holder gets the same one, and moving the element between
   * holders keeps it playing. A quiet hold, like a preview, never makes a feed audible.
   */
  acquire(channelId: string, { quiet = false }: HoldOptions = {}): StreamHandle | null {
    const channel = this.channelOf(channelId);
    if (!channel) return null;
    const pending = this.pendingRelease.get(channelId);
    if (pending != null) clearTimeout(pending);
    this.pendingRelease.delete(channelId);
    const holds = this.holds.get(channelId) ?? { loud: 0, quiet: 0 };
    const wasHeard = holds.loud > 0;
    if (quiet) holds.quiet += 1;
    else holds.loud += 1;
    this.holds.set(channelId, holds);

    let handle = this.handles.get(channelId);
    if (!handle) {
      const created = new StreamHandle(channel, {
        join: () => joinPoint({ live: this.live, fromStart: this.fromStart, started: this.started }),
        clockTime: () => this.now(),
        onChange: () => this.publishStreams(),
      });
      handle = created;
      this.handles.set(channelId, created);
      this.publishStreams();
      const { audioChannelId, volume } = useSession.getState();
      created.video.volume = volume;
      created.video.muted = channelId !== audioChannelId;
      this.startQueue = this.startQueue.then(() => this.startInTurn(created));
    }
    if (!quiet && !wasHeard && useSession.getState().audioChannelId == null && channel.kind === 'main') this.setAudio(channelId);
    return handle;
  }

  private async startInTurn(handle: StreamHandle): Promise<void> {
    if (this.handles.get(handle.channel.id) !== handle) return;
    void handle.start();
    const deadline = performance.now() + START_STAGGER_MAX_MS;
    while (performance.now() < deadline && this.handles.get(handle.channel.id) === handle) {
      if (handle.hasMedia || handle.status === 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Gives a hold back. The stream stops once nobody holds it, a moment later rather than at once:
   * a preview handing its feed to a tile lets go in the same render the tile takes hold.
   */
  release(channelId: string, { quiet = false }: HoldOptions = {}): void {
    const holds = this.holds.get(channelId);
    if (!holds) return;
    if (quiet) holds.quiet = Math.max(0, holds.quiet - 1);
    else holds.loud = Math.max(0, holds.loud - 1);
    if (holds.loud === 0 && useSession.getState().audioChannelId === channelId) this.setAudio(this.defaultAudioChannel());
    if (holds.loud + holds.quiet > 0 || this.pendingRelease.has(channelId)) return;
    this.pendingRelease.set(
      channelId,
      setTimeout(() => {
        this.pendingRelease.delete(channelId);
        const now = this.holds.get(channelId);
        if (now && now.loud + now.quiet === 0) this.stop(channelId);
      }, 0),
    );
  }

  private stop(channelId: string): void {
    const handle = this.handles.get(channelId);
    this.holds.delete(channelId);
    if (!handle) return;
    if (this.referenceId === channelId) {
      // The clock outlives the reference: remember where we are for whoever takes over.
      this.setVirtualTime(handle.video.currentTime);
      this.referenceId = null;
    }
    handle.destroy();
    this.handles.delete(channelId);
    this.held.delete(channelId);
    this.publishStreams();
  }

  handle(channelId: string): StreamHandle | undefined {
    return this.handles.get(channelId);
  }

  /** The main feed if something shows it out loud, otherwise the first such feed. */
  private defaultAudioChannel(): string | null {
    const ids = [...this.handles.keys()].filter((id) => (this.holds.get(id)?.loud ?? 0) > 0);
    return ids.find((id) => this.channelOf(id)?.kind === 'main') ?? ids[0] ?? null;
  }

  setAudio(channelId: string | null): void {
    for (const [id, handle] of this.handles) handle.video.muted = id !== channelId;
    useSession.setState({ audioChannelId: channelId });
  }

  applyVolume(volume: number): void {
    for (const handle of this.handles.values()) handle.video.volume = volume;
  }

  /** Makes the default feed audible, if there's one to hear. */
  restoreAudio(): boolean {
    const channelId = this.defaultAudioChannel();
    if (channelId) this.setAudio(channelId);
    return channelId != null;
  }

  private setVirtualTime(t: number): void {
    this.virtualTime = t;
    this.virtualAt = performance.now();
  }

  /** The session's current position, with or without a stream to read it from. */
  now(): number {
    const ref = this.referenceId ? this.handles.get(this.referenceId) : null;
    if (ref) return ref.video.currentTime;
    if (!this.wantPlaying || !this.started) return this.virtualTime;
    return this.virtualTime + (performance.now() - this.virtualAt) / 1000;
  }

  play(): void {
    this.setVirtualTime(this.now());
    this.wantPlaying = true;
    this.tick();
  }

  pause(): void {
    this.setVirtualTime(this.now());
    this.wantPlaying = false;
    this.tick();
  }

  seek(timeSec: number): void {
    const { start, end } = useSession.getState().clock;
    const target = end > start ? Math.max(start, Math.min(timeSec, end - 0.5)) : Math.max(0, timeSec);
    this.setVirtualTime(target);
    let i = 0;
    for (const handle of this.handles.values()) {
      if (!handle.hasMedia) continue;
      handle.markSyncing();
      const stagger = (i += 1) * SEEK_STAGGER_MS;
      if (handle.channel.id === this.referenceId) handle.video.currentTime = target;
      else setTimeout(() => { handle.video.currentTime = target; }, stagger);
    }
    this.tick();
  }

  /** Back to the start of the broadcast, or the start of the seekable window when live. */
  seekToStart(): void {
    if (!this.started) {
      // Nothing is playing yet, so there's no range to seek in: start there instead.
      this.fromStart = true;
      return;
    }
    const { start, end } = useSession.getState().clock;
    this.seek(this.live && end > start ? start + LIVE_START_MARGIN_SEC : start);
  }

  goLive(): void {
    const { end } = useSession.getState().clock;
    if (end > 0) this.seek(end - LIVE_EDGE_OFFSET_SEC);
  }

  private tick(): void {
    const entries = [...this.handles.values()].map((h) => ({
      id: h.channel.id,
      isMain: h.channel.kind === 'main',
      hasMedia: h.hasMedia,
      handle: h,
    }));
    const reference = pickReference(entries, this.referenceId);
    const previousReference = this.referenceId;
    this.referenceId = reference?.id ?? null;

    let timeSec: number;
    let buffering = false;
    let wallClockMs: number | null = null;
    let range: { start: number; end: number } | null = null;
    let live = this.live;

    if (reference) {
      this.started = true;
      const ref = reference.handle;
      // A stream taking over as reference must first land on the session's position.
      if (previousReference !== reference.id && previousReference === null && this.virtualTime > 0) {
        if (Math.abs(ref.video.currentTime - this.virtualTime) > 1 && !ref.video.seeking) {
          ref.video.currentTime = this.virtualTime;
        }
      }
      const others: SyncEntry[] = entries
        .filter((e) => e.id !== reference.id && e.handle.hasMedia)
        .map((e) => ({ id: e.id, video: e.handle.video, offsetSec: 0 }));
      const outcomes = syncTick({
        reference: { id: reference.id, video: ref.video, offsetSec: 0 },
        others,
        wantPlaying: this.wantPlaying,
        held: this.held,
      });
      for (const o of outcomes) if (o.aligned) this.handles.get(o.id)?.markReady();

      timeSec = ref.video.currentTime;
      this.setVirtualTime(timeSec);
      buffering = this.wantPlaying && isStalled(ref.video);
      wallClockMs = ref.wallClockMs();
      range = ref.seekRange();
      live = ref.isLive() || this.live;
    } else {
      timeSec = this.now();
    }

    this.sessionData?.update(timeSec, wallClockMs);

    const prev = useSession.getState().clock;
    const start = range?.start ?? prev.start;
    const end = range?.end ?? prev.end;
    const next: ClockState = {
      timeSec,
      playing: this.wantPlaying,
      buffering,
      live,
      start,
      end,
      atLiveEdge: live && end > 0 && end - timeSec < LIVE_EDGE_TOLERANCE_SEC,
      wallClockMs,
    };
    useSession.setState({ clock: next });
  }

  destroy(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    this.sessionData?.destroy();
    this.sessionData = null;
    for (const timer of this.pendingRelease.values()) clearTimeout(timer);
    this.pendingRelease.clear();
    this.holds.clear();
    for (const handle of this.handles.values()) handle.destroy();
    this.handles.clear();
  }
}

let runtime: SessionRuntime | null = null;

function setVolume(level: number): void {
  const volume = normalizeVolume(level);
  if (volume > 0) lastHeardVolume = volume;
  useSession.setState({ volume });
  runtime?.applyVolume(volume);
}

function toggleMute(): void {
  const { audioChannelId, volume } = useSession.getState();
  // With no feed chosen, "unmute" has to choose one, and be heard once it has.
  if (audioChannelId == null && runtime?.restoreAudio()) {
    if (volume === 0) setVolume(toggledVolume(volume, lastHeardVolume));
    return;
  }
  setVolume(toggledVolume(volume, lastHeardVolume));
}

/** Opens a session: resolves its channels. Streams start only when something acquires them. */
export async function openSession(session: SessionInfo, options: { fromStart?: boolean } = {}): Promise<Channel[]> {
  closeSession();
  const channels = await window.f1a.f1tv.channels(session.contentId);
  useSession.setState({ ...INITIAL, session, channels });
  runtime = new SessionRuntime(session, options.fromStart ?? false);
  return channels;
}

export function closeSession(): void {
  runtime?.destroy();
  runtime = null;
  useSession.setState(INITIAL);
}

export const sessionControl = {
  acquire: (channelId: string, options?: HoldOptions) => runtime?.acquire(channelId, options) ?? null,
  release: (channelId: string, options?: HoldOptions) => runtime?.release(channelId, options),
  handle: (channelId: string) => runtime?.handle(channelId),
  play: () => runtime?.play(),
  pause: () => runtime?.pause(),
  seek: (timeSec: number) => runtime?.seek(timeSec),
  seekBy: (deltaSec: number) => {
    if (runtime) runtime.seek(runtime.now() + deltaSec);
  },
  seekToStart: () => runtime?.seekToStart(),
  goLive: () => runtime?.goLive(),
  setAudio: (channelId: string | null) => runtime?.setAudio(channelId),
  setVolume,
  changeVolumeBy: (amount: number) => setVolume(useSession.getState().volume + amount),
  toggleMute,
  toggle: () => {
    if (!runtime) return;
    if (useSession.getState().clock.playing) runtime.pause();
    else runtime.play();
  },
};
