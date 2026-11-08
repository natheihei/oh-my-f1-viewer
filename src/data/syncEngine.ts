/**
 * Keeps every stream on one timeline. Ported from F1OpenViewer's sync engine with React removed:
 * the correction decisions stay in vendor/syncPlan.ts (seek on large drift, playback-rate nudge on
 * small drift, hold everyone while the reference stalls). What is new here is the wanted-state
 * model (the clock decides play/pause, not the reference element) and the reveal signal, which
 * tells the session when a stream is aligned enough to be shown.
 */
import { planCorrection, type SeekRange } from './vendor/syncPlan';

export interface VideoLike {
  currentTime: number;
  paused: boolean;
  readyState: number;
  playbackRate: number;
  seeking: boolean;
  duration: number;
  seekable: { length: number; start(i: number): number; end(i: number): number };
  play(): Promise<void>;
  pause(): void;
}

export interface SyncEntry {
  id: string;
  video: VideoLike;
  /** The channel's picture offset from the reference timeline, seconds. */
  offsetSec: number;
}

export interface SyncOutcome {
  id: string;
  /** Signed drift from the reference, seconds (negative means behind). */
  drift: number;
  /** Close enough to the reference, and decoded, to be shown. */
  aligned: boolean;
}

const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
/** Drift tolerated before correcting. */
export const SYNC_THRESHOLD_SEC = 0.05;
/** A tile may appear once within this; the rate nudge removes the rest while it is on screen. */
export const REVEAL_TOLERANCE_SEC = 0.25;
/** While paused there is no rate to nudge, so only visible misalignment is corrected. */
const PAUSED_SEEK_THRESHOLD_SEC = 0.1;

const HAVE_METADATA = 1;

export function isLiveVideo(video: Pick<VideoLike, 'duration'>): boolean {
  const d = video.duration;
  return !Number.isFinite(d) || d > 60 * 60 * 24;
}

function seekRangeOf(video: VideoLike): SeekRange | null {
  try {
    const s = video.seekable;
    if (s && s.length > 0) return { start: s.start(0), end: s.end(s.length - 1) };
  } catch {
    // Reading seekable can throw while a source is detaching.
  }
  return null;
}

function setRate(video: VideoLike, rate: number): void {
  if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
}

function safePlay(video: VideoLike): void {
  video.play().catch(() => {});
}

export interface TickInput {
  reference: SyncEntry;
  others: SyncEntry[];
  wantPlaying: boolean;
  /** Streams the engine paused itself, so only those get resumed. */
  held: Set<string>;
}

export function isStalled(video: VideoLike): boolean {
  return video.seeking || video.readyState < HAVE_FUTURE_DATA;
}

/** One pass over all streams. Reads and corrects the elements in place. */
export function syncTick({ reference, others, wantPlaying, held }: TickInput): SyncOutcome[] {
  const ref = reference.video;
  setRate(ref, 1);

  if (wantPlaying && ref.paused) safePlay(ref);
  if (!wantPlaying && !ref.paused) ref.pause();

  const refTime = ref.currentTime - reference.offsetSec;
  const refStalled = wantPlaying && isStalled(ref);
  const refLive = isLiveVideo(ref);
  const outcomes: SyncOutcome[] = [{ id: reference.id, drift: 0, aligned: ref.readyState >= HAVE_CURRENT_DATA }];

  for (const entry of others) {
    const v = entry.video;
    if (v.readyState < HAVE_METADATA) {
      outcomes.push({ id: entry.id, drift: 0, aligned: false });
      continue;
    }
    const streamTime = v.currentTime - entry.offsetSec;
    const drift = streamTime - refTime;
    const aligned = v.readyState >= HAVE_CURRENT_DATA && !v.seeking && Math.abs(drift) <= REVEAL_TOLERANCE_SEC;
    outcomes.push({ id: entry.id, drift, aligned });

    if (!wantPlaying) {
      setRate(v, 1);
      if (!v.paused) v.pause();
      held.delete(entry.id);
      if (Math.abs(drift) >= PAUSED_SEEK_THRESHOLD_SEC && !v.seeking) v.currentTime = refTime + entry.offsetSec;
      continue;
    }

    if (refStalled) {
      // Hold the line: correcting against a stalled reference only causes more buffering.
      setRate(v, 1);
      if (!v.paused) {
        v.pause();
        held.add(entry.id);
      }
      continue;
    }

    if (held.has(entry.id) || v.paused) {
      held.delete(entry.id);
      safePlay(v);
    }
    if (v.seeking) continue;

    const streamLive = isLiveVideo(v);
    const plan = planCorrection({
      offset: drift,
      threshold: SYNC_THRESHOLD_SEC,
      canSeek: true,
      refBuffering: false,
      refLive,
      streamLive,
      refTime: refTime + entry.offsetSec,
      seekable: refLive || streamLive ? seekRangeOf(v) : null,
      streamTime: v.currentTime,
    });
    if (plan.kind === 'seek') {
      setRate(v, 1);
      v.currentTime = plan.to;
    } else if (plan.kind === 'rate') {
      setRate(v, plan.rate);
    } else {
      setRate(v, 1);
    }
  }
  return outcomes;
}

/** The main feed leads when it is usable; otherwise the first stream that has media. */
export function pickReference<T extends { id: string; isMain: boolean; hasMedia: boolean }>(
  entries: T[],
  currentId: string | null,
): T | null {
  const usable = entries.filter((e) => e.hasMedia);
  const main = usable.find((e) => e.isMain);
  if (main) return main;
  const current = usable.find((e) => e.id === currentId);
  return current ?? usable[0] ?? null;
}
