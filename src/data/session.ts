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
import { track } from './telemetry';

const TICK_MS = 200;
/**
 * Session data follows the video this often, apart from the sync tick: telemetry comes about every 260ms, and
 * a 200ms playhead would play its samples out in uneven steps of 200 and 400ms.
 */
const PLAYHEAD_MS = 100;
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

/** One video: a feed playing in one place. A feed shown in two places is two videos, each its own stream. */
export interface StreamView {
  /** The video's id, which audio and the clock name it by. */
  id: string;
  /** The feed it plays. */
  feed: string;
  /** The tile it's in, or null outside one, as in a preview. */
  tile: string | null;
  /** A quiet video, like a preview's, is never heard. */
  quiet: boolean;
  status: StreamStatus;
  error: string | null;
}

export interface SessionState {
  session: SessionInfo | null;
  channels: Channel[];
  /** Why opening failed, if it did. */
  error: string | null;
  /** Every video, by its id. */
  streams: Record<string, StreamView>;
  /** The one video that is heard, by its id. */
  audioVideoId: string | null;
  /** Master level from 0 to 1, whichever video is audible. It outlives any one session. */
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
  audioVideoId: null,
  clock: IDLE_CLOCK,
};

export const useSession = create<SessionState>(() => ({ ...INITIAL, volume: 1 }));

/** The level the mute icon goes back to. */
let lastHeardVolume = 1;

const LIVE_EDGE_TOLERANCE_SEC = 15;
/** A seek this close to where it was asked for still counts as getting there: seek stops short of the end. */
const SEEK_CLAMP_TOLERANCE_SEC = 1;

export interface HoldOptions {
  /** A hold that shows the feed without ever making it audible, like a preview. */
  quiet?: boolean;
  /** The tile it's drawn in, so the sound can stay in that tile when the video goes. */
  tile?: string | null;
  /** Which of the tile's pictures it is, so the sound follows a picture that switches feed. */
  slot?: string | null;
}

interface Hold {
  quiet: boolean;
  tile: string | null;
  slot: string | null;
  /** When it was taken, in order: a later number is a later hold. */
  seq: number;
}

/** Video ids count up across sessions, so one never names a video of an earlier session. */
let nextVideo = 0;

class SessionRuntime {
  /** Every video by its id, in the order they started: a let-go one stays here until it stops. */
  private readonly handles = new Map<string, StreamHandle>();
  private readonly held = new Set<string>();
  /** Who holds each video. A video has one holder at most. */
  private readonly holds = new Map<string, Hold>();
  /** Videos let go a moment ago, which the next hold on the same feed takes over. */
  private readonly letGo = new Map<string, { hold: Hold; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private playheadTimer: ReturnType<typeof setInterval> | null = null;
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
    this.playheadTimer = setInterval(() => this.followPlayhead(), PLAYHEAD_MS);
    this.sessionData = openSessionData(session, this.live);
  }

  private channelOf(channelId: string): Channel | undefined {
    return useSession.getState().channels.find((c) => c.id === channelId);
  }

  private publishStreams(): void {
    const streams: Record<string, StreamView> = {};
    for (const [id, h] of this.handles) {
      const hold = this.holds.get(id) ?? this.letGo.get(id)?.hold;
      streams[id] = { id, feed: h.channel.id, tile: hold?.tile ?? null, quiet: hold?.quiet ?? true, status: h.status, error: h.error };
    }
    useSession.setState({ streams });
  }

  /**
   * Starts a video of a feed for one holder. Each hold is its own video and stream, so a feed can
   * show in several places. A video of the same feed let go a moment ago is taken over instead: a
   * preview handing its feed to a tile, or a component drawn again, lets go in the same render the
   * new holder takes hold, and the picture and its sound carry on. A quiet hold, like a preview,
   * never makes a video audible.
   */
  acquire(channelId: string, { quiet = false, tile = null, slot = null }: HoldOptions = {}): StreamHandle | null {
    const channel = this.channelOf(channelId);
    if (!channel) return null;
    const hold: Hold = { quiet, tile, slot, seq: (this.seq += 1) };
    const free = [...this.letGo.entries()].filter(([id]) => this.handles.get(id)?.channel.id === channelId);
    const taken = free.find(([, l]) => l.hold.tile === tile && tile != null) ?? free[0];
    if (taken) {
      const [id, l] = taken;
      clearTimeout(l.timer);
      this.letGo.delete(id);
      this.holds.set(id, hold);
      const handle = this.handles.get(id)!;
      const { audioVideoId } = useSession.getState();
      if (quiet && audioVideoId === id) this.setAudio(this.successor(id, l.hold));
      // A preview of the main feed becoming its tile is heard as a new tile of it would be.
      else if (!quiet && audioVideoId == null && channel.kind === 'main') this.setAudio(id);
      this.publishStreams();
      return handle;
    }

    const id = `v${(nextVideo += 1)}`;
    const created = new StreamHandle(id, channel, {
      join: () => joinPoint({ live: this.live, fromStart: this.fromStart, started: this.started }),
      clockTime: () => this.now(),
      onChange: () => this.publishStreams(),
    });
    this.handles.set(id, created);
    this.holds.set(id, hold);
    this.publishStreams();
    const { audioVideoId, volume } = useSession.getState();
    created.video.volume = volume;
    created.video.muted = true;
    this.startQueue = this.startQueue.then(() => this.startInTurn(created));
    if (!quiet && audioVideoId == null && channel.kind === 'main') this.setAudio(id);
    return created;
  }

  private async startInTurn(handle: StreamHandle): Promise<void> {
    if (this.handles.get(handle.id) !== handle) return;
    void handle.start();
    const deadline = performance.now() + START_STAGGER_MAX_MS;
    while (performance.now() < deadline && this.handles.get(handle.id) === handle) {
      if (handle.hasMedia || handle.status === 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Gives a video back. It stops a moment later rather than at once, unless a new hold on its feed
   * takes it over first. If it was heard, the sound moves on as `successor` says.
   */
  release(handle: StreamHandle): void {
    const { id } = handle;
    const hold = this.holds.get(id);
    if (!hold || this.handles.get(id) !== handle) return;
    this.holds.delete(id);
    const released: Hold = { ...hold, seq: (this.seq += 1) };
    this.letGo.set(id, {
      hold: released,
      timer: setTimeout(() => {
        if (!this.letGo.delete(id)) return;
        const next = useSession.getState().audioVideoId === id ? this.successor(id, released) : undefined;
        this.stop(id);
        if (next !== undefined) this.setAudio(next);
      }, 0),
    });
  }

  /**
   * Where the sound goes when the heard video stops: another video of the same feed, so the same
   * commentary carries on; else a video its tile started just after it, the same picture first, so
   * a tile switching feeds keeps the sound; else the default.
   */
  private successor(goneId: string, gone: Hold): string | null {
    const feed = this.handles.get(goneId)?.channel.id ?? null;
    const loud = [...this.holds.entries()].filter(([id, h]) => !h.quiet && id !== goneId);
    const sameFeed = loud.find(([id]) => this.handles.get(id)?.channel.id === feed);
    if (sameFeed) return sameFeed[0];
    if (gone.tile != null) {
      const after = loud.filter(([, h]) => h.tile === gone.tile && h.seq > gone.seq);
      const pick = after.find(([, h]) => gone.slot != null && h.slot === gone.slot) ?? after[0];
      if (pick) return pick[0];
    }
    return this.defaultAudio(goneId);
  }

  private stop(id: string): void {
    const handle = this.handles.get(id);
    this.holds.delete(id);
    if (!handle) return;
    if (this.referenceId === id) {
      // The clock outlives the reference: remember where we are for whoever takes over.
      this.setVirtualTime(handle.video.currentTime);
      this.referenceId = null;
    }
    handle.destroy();
    this.handles.delete(id);
    this.held.delete(id);
    this.publishStreams();
  }

  handle(id: string): StreamHandle | undefined {
    return this.handles.get(id);
  }

  /** The oldest video of the main feed that something shows out loud, otherwise the oldest such video. */
  private defaultAudio(except: string | null = null): string | null {
    const ids = [...this.holds.entries()].filter(([id, h]) => !h.quiet && id !== except).map(([id]) => id);
    return ids.find((id) => this.handles.get(id)?.channel.kind === 'main') ?? ids[0] ?? null;
  }

  /** Makes one video the only one heard, or none. A video that isn't held out loud, like a preview's, can't be. */
  setAudio(videoId: string | null): void {
    if (videoId != null) {
      const hold = this.holds.get(videoId);
      if (!hold) throw new Error(`No video ${videoId} is on screen.`);
      if (hold.quiet) throw new Error('A preview is never heard.');
    }
    for (const [id, handle] of this.handles) handle.video.muted = id !== videoId;
    useSession.setState({ audioVideoId: videoId });
  }

  applyVolume(volume: number): void {
    for (const handle of this.handles.values()) handle.video.volume = volume;
  }

  /** Makes the default video audible, if there's one to hear. */
  restoreAudio(): boolean {
    const id = this.defaultAudio();
    if (id) this.setAudio(id);
    return id != null;
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

  /** Returns where it landed, after keeping to the seekable range. */
  seek(timeSec: number): number {
    const { start, end } = useSession.getState().clock;
    const target = end > start ? Math.max(start, Math.min(timeSec, end - 0.5)) : Math.max(0, timeSec);
    this.setVirtualTime(target);
    let i = 0;
    for (const handle of this.handles.values()) {
      if (!handle.hasMedia) continue;
      handle.markSyncing();
      const stagger = (i += 1) * SEEK_STAGGER_MS;
      if (handle.id === this.referenceId) handle.video.currentTime = target;
      else setTimeout(() => { handle.video.currentTime = target; }, stagger);
    }
    this.tick();
    return target;
  }

  /** Seeks to a moment on the session database's clock (UTC milliseconds). */
  seekToDate(dateMs: number, offsetSec = 0): { timeSec: number; clamped: boolean } {
    const at = this.sessionData?.videoTimeOf(dateMs) ?? null;
    if (at === null) throw new Error("The video can't be matched to the session data yet, so that moment can't be found on it.");
    return this.seekWithin(at + offsetSec);
  }

  /** Seeks, and says where it landed and whether the seekable range stopped it short. */
  seekWithin(wanted: number): { timeSec: number; clamped: boolean } {
    const timeSec = this.seek(wanted);
    return { timeSec, clamped: Math.abs(timeSec - wanted) > SEEK_CLAMP_TOLERANCE_SEC };
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

  /** Between sync ticks, moves session data's playhead to the reference stream's frame. The tick does it when there's none. */
  private followPlayhead(): void {
    const ref = this.referenceId ? this.handles.get(this.referenceId) : undefined;
    if (ref?.hasMedia) this.sessionData?.update(ref.video.currentTime, ref.wallClockMs());
  }

  private tick(): void {
    const entries = [...this.handles.values()].map((h) => ({
      id: h.id,
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
    if (this.playheadTimer != null) clearInterval(this.playheadTimer);
    this.timer = null;
    this.playheadTimer = null;
    this.sessionData?.destroy();
    this.sessionData = null;
    for (const { timer } of this.letGo.values()) clearTimeout(timer);
    this.letGo.clear();
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
  const { audioVideoId, volume } = useSession.getState();
  // With no video chosen, "unmute" has to choose one, and be heard once it has.
  if (audioVideoId == null && runtime?.restoreAudio()) {
    if (volume === 0) setVolume(toggledVolume(volume, lastHeardVolume));
    return;
  }
  setVolume(toggledVolume(volume, lastHeardVolume));
}

/**
 * Opens a session: resolves its channels. Streams start only when something acquires them. The session is
 * a new object each time, even for the same one again, so an opening can be told from the last.
 */
export async function openSession(session: SessionInfo, options: { fromStart?: boolean } = {}): Promise<Channel[]> {
  closeSession();
  const channels = await window.omfv.f1tv.channels(session.contentId);
  useSession.setState({ ...INITIAL, session: { ...session }, channels });
  track('session_opened', { session_type: session.type, live: session.status === 'live', year: session.year });
  runtime = new SessionRuntime(session, options.fromStart ?? false);
  return channels;
}

export function closeSession(): void {
  if (runtime) track('session_closed');
  runtime?.destroy();
  runtime = null;
  useSession.setState(INITIAL);
}

export const sessionControl = {
  acquire: (channelId: string, options?: HoldOptions) => runtime?.acquire(channelId, options) ?? null,
  release: (handle: StreamHandle) => runtime?.release(handle),
  /** A video by its id, to draw it. */
  video: (id: string) => runtime?.handle(id),
  play: () => runtime?.play(),
  pause: () => runtime?.pause(),
  seek: (timeSec: number) => {
    runtime?.seek(timeSec);
  },
  seekToDate: (dateMs: number, offsetSec = 0) => {
    if (!runtime) throw new Error('No session is open.');
    return runtime.seekToDate(dateMs, offsetSec);
  },
  /** Returns where it landed, or null with no session open. */
  seekBy: (deltaSec: number): { timeSec: number; clamped: boolean } | null => (runtime ? runtime.seekWithin(runtime.now() + deltaSec) : null),
  seekToStart: () => runtime?.seekToStart(),
  goLive: () => runtime?.goLive(),
  setAudio: (videoId: string | null) => {
    if (!runtime) {
      if (videoId != null) throw new Error('No session is open.');
      return;
    }
    runtime.setAudio(videoId);
  },
  setVolume,
  changeVolumeBy: (amount: number) => setVolume(useSession.getState().volume + amount),
  toggleMute,
  toggle: () => {
    if (!runtime) return;
    if (useSession.getState().clock.playing) runtime.pause();
    else runtime.play();
  },
};
