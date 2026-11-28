import { describe, expect, it } from 'vitest';
import { computeClockStartOffset, computeFeedBaseUtc, readFeedClock } from '../../shared/feedTime';
import { buildTimeMap, LIVE_FRAME_LEAD_MS, playheadOf, videoTimeOf, videoToFeedOffset } from './timeMap';

const UTC = '2026-11-01T20:00:00.000Z';
const utcMs = Date.parse(UTC);

const feeds = {
  ExtrapolatedClock: [
    { offsetMs: 1_000, data: { Utc: UTC, Extrapolating: false } },
    { offsetMs: 2_000_000, data: { Extrapolating: true } },
  ],
};
const mapOf = (byFeed: Parameters<typeof readFeedClock>[0], durationMs: number, sessionStartSec: number | null) =>
  buildTimeMap(readFeedClock(byFeed, durationMs), sessionStartSec);

describe('time mapping', () => {
  it('anchors the feed start from any record carrying a Utc', () => {
    expect(computeFeedBaseUtc(feeds)).toBe(utcMs - 1_000);
  });

  it('finds where the session clock starts', () => {
    expect(computeClockStartOffset(feeds)).toBe(2_000_000);
  });

  it('maps lights out to lights out using the sync API anchor', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    // Video second 512.9 is lights out, which is feed offset 2,000,000.
    expect(videoToFeedOffset(map, 512.9)).toBeCloseTo(2_000_000);
  });

  it('never leaves the feed range', () => {
    const map = mapOf(feeds, 3_000_000, 512.9);
    expect(videoToFeedOffset(map, -(10 ** 6))).toBe(0);
    expect(videoToFeedOffset(map, 10 ** 7)).toBe(3_000_000);
  });

  it('falls back to the scheduled start when there is no sync data', () => {
    const scheduled = {
      ...feeds,
      SessionInfo: [{ offsetMs: 0, data: { StartDate: '2026-11-01T14:00:00', GmtOffset: '-06:00:00' } }],
    };
    expect(mapOf(scheduled, 9_000_000, null).leadInMs).toBe(1_000);
  });
});

describe('the frame on the database clock (signal-driven)', () => {
  it('prefers a real DASH wall clock over curated VOD session_start so live/DVR streams never spoil (C1)', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    // Live/DVR stream: wallClockMs is present and video.currentTime is availabilityStartTime-based (~91M s).
    expect(playheadOf(map, 91_736_188, utcMs)).toBe(utcMs - LIVE_FRAME_LEAD_MS);
    expect(playheadOf(map, 91_736_188, utcMs, 7_552)).toBe(utcMs - 7_552);
    // VOD replay: wallClockMs is null, so curated MultiViewer session_start aligns exactly.
    expect(playheadOf(map, 512.9, null)).toBeCloseTo(utcMs - 1_000 + 2_000_000);
  });

  it('uses a real DASH wall clock when there is no curated anchor, less its lead', () => {
    expect(LIVE_FRAME_LEAD_MS).toBe(7_600);
    expect(playheadOf(null, 100, utcMs)).toBe(utcMs - LIVE_FRAME_LEAD_MS);
    expect(playheadOf(mapOf(feeds, 9_000_000, null), 1_234.5, utcMs)).toBe(utcMs - LIVE_FRAME_LEAD_MS);
  });

  it("uses MultiViewer's own lead for the session once it's published", () => {
    expect(playheadOf(null, 100, utcMs, 7_552)).toBe(utcMs - 7_552);
  });

  it('waits briefly (awaiting-video) when expecting a stream wall clock before media loads', () => {
    expect(playheadOf(null, 0, null, null, true)).toBe('awaiting-video');
    expect(playheadOf(mapOf(feeds, 9_000_000, null), 0, null, null, true)).toBe('awaiting-video');
  });

  it("reports no-feed-clock or no-anchor once there is no wall clock and no curated anchor", () => {
    expect(playheadOf(null, 100, null, null, false)).toBe('no-feed-clock');
    expect(playheadOf(mapOf({}, 0, 100), 100, null, null, false)).toBe('no-feed-clock');
    const scheduled = {
      ...feeds,
      SessionInfo: [{ offsetMs: 0, data: { StartDate: '2026-11-01T14:00:00', GmtOffset: '-06:00:00' } }],
    };
    expect(playheadOf(mapOf(scheduled, 9_000_000, null), 1_234.5, null, null, false)).toBe('no-anchor');
  });
});

describe('a moment on the database clock, back to the video', () => {
  it('inverts a curated replay exactly', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    for (const t of [0, 512.9, 3_600.25, 7_000]) {
      const at = map.feedBaseUtc! + videoToFeedOffset(map, t);
      expect(videoTimeOf(map, at, 0, null)).toBeCloseTo(t);
    }
  });

  it('ignores where the video is now on a curated VOD replay (wallClockMs is null)', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    const lightsOut = utcMs - 1_000 + 2_000_000;
    expect(videoTimeOf(map, lightsOut, 4_000, null)).toBeCloseTo(512.9);
  });

  it('uses relative wall-clock offset on a live/DVR stream even when a curated map exists (C1)', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    const shown = utcMs - LIVE_FRAME_LEAD_MS;
    expect(videoTimeOf(map, shown + 15_000, 91_736_188, utcMs)).toBe(91_736_203);
  });

  it('keeps a curated replay within the feed', () => {
    const map = mapOf(feeds, 3_000_000, 512.9);
    const base = map.feedBaseUtc!;
    expect(videoTimeOf(map, base - 10 ** 9, 0, null)).toBeCloseTo(-map.leadInMs / 1000);
    expect(videoTimeOf(map, base + 10 ** 10, 0, null)).toBeCloseTo((3_000_000 - map.leadInMs) / 1000);
  });

  it('moves by the difference from the frame on screen when aligned by wall clock', () => {
    const shown = utcMs - LIVE_FRAME_LEAD_MS;
    expect(videoTimeOf(null, shown + 5_000, 300, utcMs)).toBe(305);
    expect(videoTimeOf(null, shown - 20_000, 300, utcMs)).toBe(280);
    expect(videoTimeOf(null, utcMs - 7_552 + 5_000, 300, utcMs, 7_552)).toBe(305);
    const target = videoTimeOf(null, shown + 90_000, 300, utcMs)!;
    expect(playheadOf(null, target, utcMs + 90_000)).toBe(shown + 90_000);
  });

  it("can't place a moment when the frame on screen can't be placed", () => {
    expect(videoTimeOf(null, utcMs, 100, null, null, true)).toBeNull();
    expect(videoTimeOf(mapOf({}, 0, 100), utcMs, 100, null, null, true)).toBeNull();
    expect(videoTimeOf(mapOf(feeds, 9_000_000, null), utcMs, 100, null, null, true)).toBeNull();
    expect(videoTimeOf(null, utcMs, 0, null, null, false)).toBeNull();
  });
});
