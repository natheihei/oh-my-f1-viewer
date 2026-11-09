import { describe, expect, it } from 'vitest';
import { computeClockStartOffset, computeFeedBaseUtc, readFeedClock } from '../../shared/feedTime';
import { buildTimeMap, playheadOf, videoToFeedOffset } from './timeMap';

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
