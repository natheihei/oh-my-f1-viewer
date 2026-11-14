import { describe, expect, it } from 'vitest';
import { describePlace, errorBlock, list, notDrawing, problemKey, renderCheckText, type PlaceHealth } from '../shared/health';

const place = (over: Partial<PlaceHealth> = {}): PlaceHealth => ({ scope: 'tile-1', where: 'tile', type: 'pace', label: 'Pace HAM', state: 'drawn', missing: [], dropped: [], message: null, since: null, ...over });
const draft = place({ scope: 'preview:pace', where: 'strip', state: 'needs_props', missing: ['driver'], message: 'Needs driver' });
const stale = place({ state: 'needs_props', missing: ['driver'], dropped: ['drivers'], message: 'Needs driver' });
const threw = place({ scope: 'tile-2', type: 'lap_controller', label: 'Lap controller', state: 'error', message: "Cannot read properties of undefined (reading 'lap')" });
const waiting = place({ scope: 'tile-3', state: 'waiting' });

describe('saying how a place stands', () => {
  it('says how to fix each kind', () => {
    expect(describePlace(draft)).toBe('Draft pace in the strip: needs driver. Call suggest_tiles with it and its props, or ask the user whose.');
    expect(describePlace(stale)).toBe('Tile tile-1 "Pace HAM" (pace): needs driver. It no longer accepts drivers. Call edit_tile on it with them, or ask the user whose.');
    expect(describePlace(threw)).toBe(`Tile tile-2 "Lap controller" (lap_controller): render error: Cannot read properties of undefined (reading 'lap'). Fix the code.`);
  });

  it('says what draws, and what waits for the viewer', () => {
    expect(describePlace(place())).toBe('Tile tile-1 "Pace HAM" (pace): drawn.');
    expect(describePlace(place({ dropped: ['laps'] }))).toBe('Tile tile-1 "Pace HAM" (pace): drawn, without laps, which it no longer accepts.');
    expect(describePlace(waiting)).toBe('Tile tile-3 "Pace HAM" (pace): waiting for the user to allow it to look ahead.');
  });

  it('lists names in words', () => {
    expect([list([]), list(['a']), list(['a', 'b']), list(['a', 'b', 'c'])]).toEqual(['', 'a', 'a and b', 'a, b and c']);
  });
});

describe('what is not drawing', () => {
  it('leaves out what draws and what waits', () => {
    expect(notDrawing([place(), draft, waiting, threw])).toEqual([draft, threw]);
  });

  it('is told to the agent as a list, with what to do after', () => {
    expect(renderCheckText([place(), draft, threw])).toBe(
      [
        "Before you finish, these aren't drawing:",
        `- ${describePlace(draft)}`,
        `- ${describePlace(threw)}`,
        'Fix what you can now. If one needs something only the user can say, ask them.',
      ].join('\n'),
    );
  });

  it('tells one problem from another, and the same place failing another way', () => {
    expect(problemKey(draft)).toBe(problemKey({ ...draft, label: 'Renamed' }));
    expect(problemKey(draft)).not.toBe(problemKey(threw));
    expect(problemKey(threw)).not.toBe(problemKey({ ...threw, message: 'another' }));
    expect(problemKey(draft)).not.toBe(problemKey({ ...draft, missing: ['driver_a'] }));
  });
});

describe('a tile attached to a message', () => {
  const since = { clockSec: 4360, playheadMs: 1761512880000 };

  it('is a block of JSON the agent reads: the place, when it first threw, its props and its log', () => {
    expect(errorBlock({ place: { ...threw, since }, props: { drivers: [4] }, log: 'lap_controller/mod.log' })).toBe(
      `<error>
{
  "tile": "tile-2",
  "label": "Lap controller",
  "type": "lap_controller",
  "state": "error",
  "message": "Cannot read properties of undefined (reading 'lap')",
  "first_threw": {
    "clock": "1:12:40",
    "playhead": 1761512880000
  },
  "props": {
    "drivers": [
      4
    ]
  },
  "log": "lap_controller/mod.log"
}
</error>`,
    );
  });

  it('says what a tile needs, and since when, and leaves out what it has none of', () => {
    const fields = JSON.parse(errorBlock({ place: { ...stale, since }, props: { drivers: [44] }, log: null }).slice('<error>'.length, -'</error>'.length));
    expect(fields).toEqual({
      tile: 'tile-1',
      label: 'Pace HAM',
      type: 'pace',
      state: 'needs_props',
      message: 'Needs driver',
      missing: ['driver'],
      dropped: ['drivers'],
      since: { clock: '1:12:40', playhead: 1761512880000 },
      props: { drivers: [44] },
    });
    expect(JSON.parse(errorBlock({ place: threw, props: {}, log: null }).slice(7, -8))).not.toHaveProperty('first_threw');
  });
});
