import { describe, expect, it, vi } from 'vitest';
import type { EventInfo } from '../../shared/api';

vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { describeEvents } = await import('./bridge');

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const event = (pageId: number, round: number, shortName: string, start: string, end: string, isTest = false): EventInfo => ({
  pageId,
  name: `FORMULA 1 ${shortName.toUpperCase()}`,
  shortName,
  round,
  startMs: day(start),
  endMs: day(end),
  isTest,
});

describe('the event list for the agent', () => {
  it('has one line per event, in date order, with the pageId list_sessions takes', () => {
    const text = describeEvents({
      state: 'ready',
      error: null,
      seasons: [
        {
          year: 2025,
          events: [
            event(10498, 20, 'Mexico City Grand Prix', '2025-10-24', '2025-10-26'),
            event(10400, 0, 'Pre-Season Testing', '2025-02-26', '2025-02-28', true),
            event(10410, 1, 'Australian Grand Prix', '2025-03-14', '2025-03-16'),
            event(10520, 21, 'São Paulo Grand Prix', '2025-10-31', '2025-11-02'),
          ],
        },
      ],
    });
    expect(text.split('\n').slice(1)).toEqual([
      '',
      '2025:',
      '10400 test Pre-Season Testing, Feb 26-28',
      '10410 R1 Australian Grand Prix, Mar 14-16',
      '10498 R20 Mexico City Grand Prix, Oct 24-26',
      '10520 R21 São Paulo Grand Prix, Oct 31-Nov 2',
    ]);
    expect(text).toMatch(/^Events on F1 TV, 2023 on\./);
  });
});
