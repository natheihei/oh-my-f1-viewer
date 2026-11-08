import { describe, expect, it } from 'vitest';
import { pickReference, syncTick, type SyncEntry, type VideoLike } from './syncEngine';

function video(overrides: Partial<VideoLike> = {}): VideoLike {
  return {
    currentTime: 100,
    paused: false,
    readyState: 4,
    playbackRate: 1,
    seeking: false,
    duration: 7200,
    seekable: { length: 1, start: () => 0, end: () => 7200 },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    ...overrides,
  };
}

const entry = (id: string, v: VideoLike, offsetSec = 0): SyncEntry => ({ id, video: v, offsetSec });

function tick(ref: VideoLike, other: VideoLike, wantPlaying = true, held = new Set<string>()) {
  return syncTick({ reference: entry('ref', ref), others: [entry('other', other)], wantPlaying, held });
}

describe('syncTick', () => {
  it('leaves an aligned stream at normal speed and reports it aligned', () => {
    const other = video({ currentTime: 100.01 });
    const out = tick(video(), other);
    expect(other.playbackRate).toBe(1);
    expect(other.currentTime).toBe(100.01);
    expect(out.find((o) => o.id === 'other')?.aligned).toBe(true);
  });

  it('nudges small drift with playback rate, in the right direction', () => {
    const behind = video({ currentTime: 99.8 });
    tick(video(), behind);
    expect(behind.playbackRate).toBeGreaterThan(1);

    const ahead = video({ currentTime: 100.2 });
    tick(video(), ahead);
    expect(ahead.playbackRate).toBeLessThan(1);
  });

  it('seeks on large drift and does not report the stream aligned', () => {
    const other = video({ currentTime: 40 });
    const out = tick(video(), other);
    expect(other.currentTime).toBe(100);
    expect(out.find((o) => o.id === 'other')?.aligned).toBe(false);
  });

  it('holds other streams while the reference stalls, and resumes only those it held', () => {
    const ref = video({ readyState: 2 });
    const other = video({ currentTime: 100 });
    const held = new Set<string>();
    tick(ref, other, true, held);
    expect(other.paused).toBe(true);
    expect(held.has('other')).toBe(true);

    ref.readyState = 4;
    tick(ref, other, true, held);
    expect(other.paused).toBe(false);
    expect(held.has('other')).toBe(false);
  });

  it('does not correct against a stalled reference', () => {
    const other = video({ currentTime: 40 });
    tick(video({ readyState: 2 }), other);
    expect(other.currentTime).toBe(40);
  });

  it('pauses everything when pausing is wanted, and keeps paused streams aligned', () => {
    const ref = video();
    const other = video({ currentTime: 95 });
    tick(ref, other, false);
    expect(ref.paused).toBe(true);
    expect(other.paused).toBe(true);
    expect(other.currentTime).toBe(100);
  });

  it('starts a paused reference when playing is wanted', () => {
    const ref = video({ paused: true });
    tick(ref, video());
    expect(ref.paused).toBe(false);
  });

  it('skips a stream with no metadata yet', () => {
    const other = video({ readyState: 0, currentTime: 0 });
    const out = tick(video(), other);
    expect(other.currentTime).toBe(0);
    expect(out.find((o) => o.id === 'other')?.aligned).toBe(false);
  });

  it('measures drift net of the channel offset', () => {
    const other = video({ currentTime: 100.4 });
    syncTick({
      reference: entry('ref', video()),
      others: [entry('other', other, 0.4)],
      wantPlaying: true,
      held: new Set(),
    });
    expect(other.currentTime).toBe(100.4);
    expect(other.playbackRate).toBe(1);
  });

  it('only seeks a live stream inside its own window', () => {
    const live = { duration: Infinity, seekable: { length: 1, start: () => 50, end: () => 200 } };
    const other = video({ ...live, currentTime: 60 });
    tick(video({ ...live, currentTime: 500 }), other);
    expect(other.currentTime).toBe(199);
  });
});

describe('pickReference', () => {
  const e = (id: string, isMain: boolean, hasMedia: boolean) => ({ id, isMain, hasMedia });

  it('prefers the main feed once it has media', () => {
    expect(pickReference([e('a', false, true), e('m', true, true)], 'a')?.id).toBe('m');
  });

  it('keeps the current reference while the main feed has no media', () => {
    expect(pickReference([e('a', false, true), e('b', false, true), e('m', true, false)], 'b')?.id).toBe('b');
  });

  it('falls back to any stream with media, or none', () => {
    expect(pickReference([e('a', false, true)], null)?.id).toBe('a');
    expect(pickReference([e('a', false, false)], null)).toBeNull();
  });
});
