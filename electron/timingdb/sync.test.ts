import { describe, expect, it } from 'vitest';
import { anchorComplete, liveLeadMs, startedAt } from './sync';

// Las Vegas FP1 2026, as the live feed and MultiViewer gave them.
const STARTED = Date.parse('2026-11-20T00:30:00.102Z');
const PDT = Date.parse('2026-11-20T00:30:07.654Z');

describe('when a live session started', () => {
  it('reads it from the snapshot, whose status series is a list', () => {
    const snapshot = {
      StatusSeries: [
        { Utc: '2026-11-20T00:18:10.039Z', TrackStatus: 'Yellow' },
        { Utc: '2026-11-20T00:30:00.102Z', SessionStatus: 'Started' },
      ],
    };
    expect(startedAt(snapshot)).toBe(STARTED);
  });

  it('reads it from an update, whose status series is keyed by index', () => {
    expect(startedAt({ StatusSeries: { '3': { Utc: '2026-11-20T00:30:00.102Z', SessionStatus: 'Started' } } })).toBe(STARTED);
  });

  it('takes the first start, not a restart after a red flag', () => {
    const series = [
      { Utc: '2026-11-20T00:30:00.102Z', SessionStatus: 'Started' },
      { Utc: '2026-11-20T00:41:00.000Z', SessionStatus: 'Aborted' },
      { Utc: '2026-11-20T00:55:00.000Z', SessionStatus: 'Started' },
    ];
    expect(startedAt({ StatusSeries: series })).toBe(STARTED);
  });

  it("is null before it has", () => {
    expect(startedAt({ StatusSeries: [{ Utc: '2026-11-20T00:18:10.039Z', TrackStatus: 'Yellow' }] })).toBeNull();
    expect(startedAt({})).toBeNull();
    expect(startedAt(null)).toBeNull();
  });
});

describe("the live stream's lead over the feed", () => {
  it("is MultiViewer's frame time at the start less the feed's start", () => {
    expect(liveLeadMs(PDT, STARTED)).toBe(7_552);
  });

  it('is unknown without both', () => {
    expect(liveLeadMs(null, STARTED)).toBeNull();
    expect(liveLeadMs(PDT, null)).toBeNull();
  });

  it("is refused when the two can't be the same moment, as with a race's lights out against its formation lap", () => {
    expect(liveLeadMs(PDT + 210_000, STARTED)).toBeNull();
    expect(liveLeadMs(STARTED - 1_000, STARTED)).toBeNull();
  });
});

describe("whether MultiViewer's anchor is complete", () => {
  it('needs the video second for a replay and the frame time for live', () => {
    expect(anchorComplete(null, false)).toBe(false);
    expect(anchorComplete({ sessionStartSec: 1162.534, sessionStartPdtMs: null }, false)).toBe(true);
    expect(anchorComplete({ sessionStartSec: 1162.534, sessionStartPdtMs: null }, true)).toBe(false);
    expect(anchorComplete({ sessionStartSec: 1162.534, sessionStartPdtMs: PDT }, true)).toBe(true);
  });
});
