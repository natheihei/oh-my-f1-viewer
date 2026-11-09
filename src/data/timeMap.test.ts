import { describe, expect, it } from 'vitest';
import { computeClockStartOffset, computeFeedBaseUtc, readFeedClock } from '../../shared/feedTime';
import { buildTimeMap, playheadOf, videoTimeOf, videoToFeedOffset } from './timeMap';

const UTC = '2026-11-01T20:00:00.000Z';
const utcMs = Date.parse(UTC);

const feeds = {
  ExtrapolatedClock: [
    { offsetMs: 1_000, data: { Utc: UTC, Extrapolating: false } },
    { offsetMs: 2_000_000, data: { Extrapolating: true } },
  ],
};
const mapOf = (byFeed: Parameters<typeof readFeedClock>[0], durationMs: number, sessionStartSec: number | null) => buildTimeMap(readFeedClock(byFeed, durationMs), sessionStartSec);

describe('time mapping', () => {
  it('anchors the feed start from any record carrying a Utc', () => {
    expect(computeFeedBaseUtc(feeds)).toBe(utcMs - 1_000);
  });

  it('finds where the session clock starts', () => {
    expect(computeClockStartOffset(feeds)).toBe(2_000_000);
  });

  it('uses the wall clock when there is no curated sync data', () => {
    const map = mapOf(feeds, 9_000_000, null);
    const frameUtc = utcMs + 60_000;
    expect(videoToFeedOffset(map, 999, frameUtc)).toBe(61_000);
  });

  it('trusts curated sync data over a wall clock that runs ahead of it', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    const lightsOutPlus15s = utcMs - 1_000 + 2_000_000 + 15_000;
    expect(videoToFeedOffset(map, 512.9, lightsOutPlus15s)).toBeCloseTo(2_000_000);
  });

  it('maps lights out to lights out using the sync API anchor, without a wall clock', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    // Video second 512.9 is lights out, which is feed offset 2,000,000.
    expect(videoToFeedOffset(map, 512.9, null)).toBeCloseTo(2_000_000);
  });

  it('never leaves the feed range', () => {
    const map = mapOf(feeds, 3_000_000, null);
    expect(videoToFeedOffset(map, 0, utcMs - 10 ** 9)).toBe(0);
    expect(videoToFeedOffset(map, 0, utcMs + 10 ** 10)).toBe(3_000_000);
  });

  it('falls back to the scheduled start when there is no sync data', () => {
    const scheduled = {
      ...feeds,
      SessionInfo: [{ offsetMs: 0, data: { StartDate: '2026-11-01T14:00:00', GmtOffset: '-06:00:00' } }],
    };
    expect(mapOf(scheduled, 9_000_000, null).leadInMs).toBe(1_000);
  });
});

describe('the frame on the database clock', () => {
  it('places a replay frame at the feed base plus its offset', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    expect(playheadOf(false, map, 512.9, null)).toBeCloseTo(utcMs - 1_000 + 2_000_000);
  });

  it("shows nothing until a replay's frame can be placed", () => {
    expect(playheadOf(false, null, 100, utcMs)).toBeNull();
    expect(playheadOf(false, mapOf({}, 0, 100), 100, utcMs)).toBeNull();
  });

  it("uses a live stream's wall clock, so rows wait for the video", () => {
    expect(playheadOf(true, null, 100, utcMs)).toBe(utcMs);
  });

  it('releases everything when a live stream has no clock to align to', () => {
    expect(playheadOf(true, null, 100, null)).toBe('everything');
  });
});

describe('a moment on the database clock, back to the video', () => {
  it('inverts a curated replay exactly', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    for (const t of [0, 512.9, 3_600.25, 7_000]) {
      const at = map.feedBaseUtc! + videoToFeedOffset(map, t, null);
      expect(videoTimeOf(false, map, at, 0, null)).toBeCloseTo(t);
    }
  });

  it('ignores where the video is now on a curated replay, and its wall clock', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    const lightsOut = utcMs - 1_000 + 2_000_000;
    expect(videoTimeOf(false, map, lightsOut, 4_000, utcMs + 10 ** 7)).toBeCloseTo(512.9);
  });

  it('inverts a replay placed by its scheduled start', () => {
    const scheduled = {
      ...feeds,
      SessionInfo: [{ offsetMs: 0, data: { StartDate: '2026-11-01T14:00:00', GmtOffset: '-06:00:00' } }],
    };
    const map = mapOf(scheduled, 9_000_000, null);
    const at = playheadOf(false, map, 1_234.5, null) as number;
    expect(videoTimeOf(false, map, at, 0, null)).toBeCloseTo(1_234.5);
  });

  it('keeps a curated replay within the feed', () => {
    const map = mapOf(feeds, 3_000_000, 512.9);
    const base = map.feedBaseUtc!;
    expect(videoTimeOf(false, map, base - 10 ** 9, 0, null)).toBeCloseTo(-map.leadInMs / 1000);
    expect(videoTimeOf(false, map, base + 10 ** 10, 0, null)).toBeCloseTo((3_000_000 - map.leadInMs) / 1000);
  });

  it('moves by the difference from the frame on screen on a wall clock', () => {
    const map = mapOf(feeds, 9_000_000, null);
    const frameUtc = utcMs + 60_000;
    expect(videoTimeOf(false, map, frameUtc + 90_000, 1_000, frameUtc)).toBe(1_090);
    expect(videoTimeOf(false, map, frameUtc - 30_000, 1_000, frameUtc)).toBe(970);
    // Round trip: the frame it names is placed at that moment.
    const target = videoTimeOf(false, map, frameUtc + 90_000, 1_000, frameUtc)!;
    expect(playheadOf(false, map, target, frameUtc + 90_000)).toBe(frameUtc + 90_000);
  });

  it('moves by the difference from the frame on screen when live', () => {
    expect(videoTimeOf(true, null, utcMs + 5_000, 300, utcMs)).toBe(305);
    expect(videoTimeOf(true, null, utcMs - 20_000, 300, utcMs)).toBe(280);
  });

  it("can't place a moment when the frame on screen can't be placed", () => {
    expect(videoTimeOf(false, null, utcMs, 100, utcMs)).toBeNull();
    expect(videoTimeOf(false, mapOf({}, 0, 100), utcMs, 100, utcMs)).toBeNull();
    expect(videoTimeOf(true, null, utcMs, 100, null)).toBeNull();
  });
});
