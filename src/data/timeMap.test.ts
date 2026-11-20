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
const mapOf = (byFeed: Parameters<typeof readFeedClock>[0], durationMs: number, sessionStartSec: number | null) => buildTimeMap(readFeedClock(byFeed, durationMs), sessionStartSec);

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

describe('the frame on the database clock', () => {
  it('places a replay frame at the feed base plus its offset', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    expect(playheadOf(false, map, 512.9, null)).toBeCloseTo(utcMs - 1_000 + 2_000_000);
  });

  it("says why a replay's frame can't be placed", () => {
    expect(playheadOf(false, null, 100, null)).toBe('no-feed-clock');
    expect(playheadOf(false, mapOf({}, 0, 100), 100, null)).toBe('no-feed-clock');
  });

  it("won't place a replay by its scheduled start, which is only good to a minute", () => {
    const scheduled = {
      ...feeds,
      SessionInfo: [{ offsetMs: 0, data: { StartDate: '2026-11-01T14:00:00', GmtOffset: '-06:00:00' } }],
    };
    expect(playheadOf(false, mapOf(scheduled, 9_000_000, null), 1_234.5, null)).toBe('no-anchor');
    expect(playheadOf(false, mapOf(feeds, 9_000_000, null), 1_234.5, utcMs)).toBe('no-anchor');
  });

  it("takes a live stream's frame time back by how far it runs ahead of the picture", () => {
    expect(LIVE_FRAME_LEAD_MS).toBe(7_600);
    expect(playheadOf(true, null, 100, utcMs)).toBe(utcMs - LIVE_FRAME_LEAD_MS);
  });

  it("uses MultiViewer's own lead for the session once it's published", () => {
    expect(playheadOf(true, null, 100, utcMs, 7_552)).toBe(utcMs - 7_552);
  });

  it("shows nothing when a live stream hasn't said what time it shows", () => {
    expect(playheadOf(true, null, 100, null)).toBe('no-wall-clock');
    expect(playheadOf(true, null, 100, null, 7_552)).toBe('no-wall-clock');
  });
});

describe('a moment on the database clock, back to the video', () => {
  it('inverts a curated replay exactly', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    for (const t of [0, 512.9, 3_600.25, 7_000]) {
      const at = map.feedBaseUtc! + videoToFeedOffset(map, t);
      expect(videoTimeOf(false, map, at, 0, null)).toBeCloseTo(t);
    }
  });

  it('ignores where the video is now on a curated replay, and its wall clock', () => {
    const map = mapOf(feeds, 9_000_000, 512.9);
    const lightsOut = utcMs - 1_000 + 2_000_000;
    expect(videoTimeOf(false, map, lightsOut, 4_000, utcMs + 10 ** 7)).toBeCloseTo(512.9);
  });

  it('keeps a curated replay within the feed', () => {
    const map = mapOf(feeds, 3_000_000, 512.9);
    const base = map.feedBaseUtc!;
    expect(videoTimeOf(false, map, base - 10 ** 9, 0, null)).toBeCloseTo(-map.leadInMs / 1000);
    expect(videoTimeOf(false, map, base + 10 ** 10, 0, null)).toBeCloseTo((3_000_000 - map.leadInMs) / 1000);
  });

  it('moves by the difference from the frame on screen when live, after its lead', () => {
    const shown = utcMs - LIVE_FRAME_LEAD_MS;
    expect(videoTimeOf(true, null, shown + 5_000, 300, utcMs)).toBe(305);
    expect(videoTimeOf(true, null, shown - 20_000, 300, utcMs)).toBe(280);
    expect(videoTimeOf(true, null, utcMs - 7_552 + 5_000, 300, utcMs, 7_552)).toBe(305);
    // Round trip: the frame it names is placed at that moment.
    const target = videoTimeOf(true, null, shown + 90_000, 300, utcMs)!;
    expect(playheadOf(true, null, target, utcMs + 90_000)).toBe(shown + 90_000);
  });

  it("can't place a moment when the frame on screen can't be placed", () => {
    expect(videoTimeOf(false, null, utcMs, 100, utcMs)).toBeNull();
    expect(videoTimeOf(false, mapOf({}, 0, 100), utcMs, 100, utcMs)).toBeNull();
    expect(videoTimeOf(false, mapOf(feeds, 9_000_000, null), utcMs, 100, utcMs)).toBeNull();
    expect(videoTimeOf(true, null, utcMs, 100, null)).toBeNull();
  });
});
