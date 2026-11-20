import { describe, expect, it } from 'vitest';
import { archiveMissing } from './archive';

// Las Vegas FP2 2026 ended at 05:00Z, and an hour later F1's index listed it with no path.
const END = Date.parse('2026-11-20T05:00:00Z');
const HOUR = 3_600_000;

describe("a replay's archive", () => {
  it('is there when the index gives a path', () => {
    expect(archiveMissing({ path: '2026/2026-11-21_Las_Vegas_Grand_Prix/2026-11-20_Practice_2/', endMs: END }, END + HOUR)).toBeNull();
  });

  it("isn't published yet when the index lists the session without a path, and is looked for again", () => {
    for (const path of ['', null, undefined]) {
      expect(archiveMissing({ path, endMs: END }, END + HOUR)).toEqual({ reason: expect.stringMatching(/hasn't published this session's timing yet/), retry: true });
    }
    expect(archiveMissing({ path: '', endMs: null }, END + HOUR)?.retry).toBe(true);
  });

  it('has nothing, for good, when there is still no path days after the session', () => {
    expect(archiveMissing({ path: '', endMs: END }, END + 4 * 24 * HOUR)).toEqual({ reason: 'The timing archive has nothing for this session.', retry: false });
  });

  it("is looked for again when the session isn't listed at all", () => {
    expect(archiveMissing(null, END + HOUR)).toEqual({ reason: "This session wasn't found in the timing archive.", retry: true });
  });
});
