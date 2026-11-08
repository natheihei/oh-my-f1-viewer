import { describe, expect, it } from 'vitest';
import { buildTimeMap, computeClockStartOffset, computeFeedBaseUtc, LiveFeedBuffer, videoToFeedOffset } from './timeMap';

const UTC = '2026-11-01T20:00:00.000Z';
const utcMs = Date.parse(UTC);

const feeds = {
  ExtrapolatedClock: [
    { offsetMs: 1_000, data: { Utc: UTC, Extrapolating: false } },
    { offsetMs: 2_000_000, data: { Extrapolating: true } },
  ],
};

describe('time mapping', () => {
  it('anchors the feed start from any record carrying a Utc', () => {
    expect(computeFeedBaseUtc(feeds)).toBe(utcMs - 1_000);
  });

  it('finds where the session clock starts', () => {
    expect(computeClockStartOffset(feeds)).toBe(2_000_000);
  });

  it('uses the wall clock when there is no curated sync data', () => {
    const map = buildTimeMap(feeds, 9_000_000, null);
    const frameUtc = utcMs + 60_000;
    expect(videoToFeedOffset(map, 999, frameUtc)).toBe(61_000);
  });

  it('trusts curated sync data over a wall clock that runs ahead of it', () => {
    const map = buildTimeMap(feeds, 9_000_000, 512.9);
    const lightsOutPlus15s = utcMs - 1_000 + 2_000_000 + 15_000;
    expect(videoToFeedOffset(map, 512.9, lightsOutPlus15s)).toBeCloseTo(2_000_000);
  });

  it('maps lights out to lights out using the sync API anchor, without a wall clock', () => {
    const map = buildTimeMap(feeds, 9_000_000, 512.9);
    // Video second 512.9 is lights out, which is feed offset 2,000,000.
    expect(videoToFeedOffset(map, 512.9, null)).toBeCloseTo(2_000_000);
  });

  it('never leaves the feed range', () => {
    const map = buildTimeMap(feeds, 3_000_000, null);
    expect(videoToFeedOffset(map, 0, utcMs - 10 ** 9)).toBe(0);
    expect(videoToFeedOffset(map, 0, utcMs + 10 ** 10)).toBe(3_000_000);
  });

  it('falls back to the scheduled start when there is no sync data', () => {
    const scheduled = {
      ...feeds,
      SessionInfo: [{ offsetMs: 0, data: { StartDate: '2026-11-01T14:00:00', GmtOffset: '-06:00:00' } }],
    };
    const map = buildTimeMap(scheduled, 9_000_000, null);
    expect(map.leadInMs).toBe(1_000);
  });
});

describe('LiveFeedBuffer', () => {
  it('holds records until the video reaches them', () => {
    const buffer = new LiveFeedBuffer<string>();
    buffer.push('a', 1_000);
    buffer.push('b', 2_000);
    expect(buffer.advance(500)).toEqual({ reset: false, records: [] });
    expect(buffer.held).toBe(2);
    expect(buffer.advance(1_500)).toEqual({ reset: false, records: ['a'] });
    expect(buffer.held).toBe(1);
    expect(buffer.advance(2_000)).toEqual({ reset: false, records: ['b'] });
    expect(buffer.held).toBe(0);
  });

  it('releases everything when the stream has no clock to align to', () => {
    const buffer = new LiveFeedBuffer<string>();
    buffer.push('a', 10 ** 13);
    expect(buffer.advance(null).records).toEqual(['a']);
  });

  it('rebuilds from the start when the video rewinds, and only up to the new position', () => {
    const buffer = new LiveFeedBuffer<string>();
    buffer.push('a', 1_000);
    buffer.push('b', 2_000);
    buffer.push('c', 3_000);
    buffer.advance(3_000);
    expect(buffer.advance(1_500)).toEqual({ reset: true, records: ['a'] });
    expect(buffer.held).toBe(2);
    expect(buffer.advance(3_000)).toEqual({ reset: false, records: ['b', 'c'] });
  });

  it('does not rebuild when the video holds still', () => {
    const buffer = new LiveFeedBuffer<string>();
    buffer.push('a', 1_000);
    buffer.advance(1_000);
    expect(buffer.advance(1_000)).toEqual({ reset: false, records: [] });
  });
});
