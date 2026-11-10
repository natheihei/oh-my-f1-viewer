import { describe, expect, it } from 'vitest';
import { specFor } from './spec';

describe('spec', () => {
  it('calls the one second line DRS until 2025, and Overtake from 2026', () => {
    expect(specFor(null).chaseAid).toEqual({ label: 'DRS', within: 1 });
    expect(specFor({ year: 2025 }).chaseAid).toEqual({ label: 'DRS', within: 1 });
    expect(specFor({ year: 2026, meetingKey: '1280', sessionKey: '11396' }).chaseAid).toEqual({ label: 'OT', within: 1 });
  });

  it('lets each level override the one above, in part', () => {
    const tree = {
      chaseAid: { label: 'DRS', within: 1 },
      years: { '2030': { chaseAid: { label: 'X' }, meetings: { '7': { sessions: { '9': { chaseAid: { within: 0.5 } } } } } } },
    };
    expect(specFor({ year: 2030 }, tree).chaseAid).toEqual({ label: 'X', within: 1 });
    expect(specFor({ year: 2030, meetingKey: 7, sessionKey: 9 }, tree).chaseAid).toEqual({ label: 'X', within: 0.5 });
    expect(specFor({ year: 2031, meetingKey: 7, sessionKey: 9 }, tree).chaseAid).toEqual({ label: 'DRS', within: 1 });
  });

  it('gives the same object for the same session, so live state can select it', () => {
    expect(specFor({ year: 2026 })).toBe(specFor({ year: 2026 }));
  });
});
