import { describe, expect, it } from 'vitest';
import { joinPoint } from './join';

describe('joinPoint', () => {
  it('joins a live session at the edge by default', () => {
    expect(joinPoint({ live: true, fromStart: false, started: false })).toBe('live-edge');
  });

  it('joins a live session at the start of the broadcast when asked', () => {
    expect(joinPoint({ live: true, fromStart: true, started: false })).toBe('live-start');
  });

  it('starts a replay at its beginning', () => {
    expect(joinPoint({ live: false, fromStart: false, started: false })).toBe('beginning');
  });

  it('follows the clock once anything has played, so a recovering stream cannot jump to the live edge', () => {
    for (const fromStart of [true, false]) {
      expect(joinPoint({ live: true, fromStart, started: true })).toBe('clock');
    }
    expect(joinPoint({ live: false, fromStart: false, started: true })).toBe('clock');
  });
});
