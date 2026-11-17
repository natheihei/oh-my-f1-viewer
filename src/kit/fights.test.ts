import { describe, expect, it } from 'vitest';
import { aheadOf, closest, fightsOf, runningOrder } from './fights';

const row = (driver_number: number, position: number, interval: unknown, is_out = 0) => ({ driver_number, position, interval, is_out });

// NOR leads, VER 0.4s behind, LEC 0.8s behind VER, HAM 3s back, PIA lapped, SAI out.
const order = runningOrder([row(4, 1, null), row(1, 2, '+0.412'), row(16, 3, '+0.8'), row(44, 4, '+3.100'), row(81, 5, '+1 LAP'), row(55, 6, null, 1)]);

describe('fights', () => {
  it('are cars next to each other within the chase aid, front to back, a train being two', () => {
    expect(fightsOf(order, 1)).toEqual([
      { ahead: 4, behind: 1, gap: 0.412, position: 1 },
      { ahead: 1, behind: 16, gap: 0.8, position: 2 },
    ]);
    expect(fightsOf(order, 0.5).map((f) => f.behind)).toEqual([1]);
  });

  it('leave out lapped and retired cars', () => {
    expect(fightsOf(order, 99).map((f) => f.behind)).toEqual([1, 16, 44]);
  });

  it('start on the closest', () => {
    expect(closest(fightsOf(order, 1))).toEqual({ ahead: 4, behind: 1, gap: 0.412, position: 1 });
    expect(closest([])).toBeNull();
  });
});

describe('the car ahead', () => {
  it('is the one in front on the road, with the gap to it', () => {
    expect(aheadOf(order, 16)).toEqual({ driver: 1, gap: 0.8 });
    expect(aheadOf(order, 81)).toEqual({ driver: 44, gap: null });
  });

  it('is none for the leader, a car that is out or one not running', () => {
    expect(aheadOf(order, 4)).toBeNull();
    expect(aheadOf(order, 55)).toBeNull();
    expect(aheadOf(order, 99)).toBeNull();
  });
});
