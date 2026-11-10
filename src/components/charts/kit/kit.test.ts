import { describe, expect, it } from 'vitest';
import type { DriverEntry, SessionDataView } from '../../../host';
import { compactSmall } from './ChartCanvas';
import { driverStyles } from './colors';
import { spreadLabels } from './labels';
import { axisLaps, isCleanLap, lapTicks, median, neutralBands, neutralOf, paceRange, tyreAgeNow } from './laps';
import { linear, niceCeil, niceStep, ticks } from './scale';
import { circuitMessage, dataMessage, viewMessage } from './status';
import { bridgeSlow, deltaAlong, fitOutline, lapDistance, lineCrossings, outlineLength, projector, rotate, timeAt } from './track';
import { compoundLetter, formatGap, formatLapTime, gapSeconds, parseGap, stintAge } from './values';

describe('scales', () => {
  it('maps a domain onto a range, either way up', () => {
    const y = linear([0, 10], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(10)).toBe(0);
    expect(y(2.5)).toBe(150);
    expect(linear([5, 5], [0, 100])(5)).toBe(0);
  });

  it('picks round steps', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(57, 6)).toBe(10);
    expect(niceStep(0.8, 4)).toBe(0.2);
    expect(niceStep(0, 4)).toBe(1);
  });

  it('ticks round values inside the range', () => {
    expect(ticks(0, 6, 3)).toEqual([0, 2, 4, 6]);
    expect(ticks(0.3, 1.1, 4)).toEqual([0.4, 0.6, 0.8, 1]);
    expect(ticks(15, 31, 0, 5)).toEqual([15, 20, 25, 30]);
    expect(ticks(1, 0, 4)).toEqual([]);
  });

  it('rounds a maximum up to the tick grid', () => {
    expect(niceCeil(4.3, 4)).toBe(6);
    expect(niceCeil(2, 4)).toBe(2);
    expect(niceCeil(23, 4)).toBe(30);
    expect(niceCeil(23, 5)).toBe(25);
    expect(niceCeil(0)).toBe(0);
  });
});

describe('compact boxes', () => {
  it('keeps a small text tile full while it is wide enough and not very short', () => {
    expect(compactSmall({ width: 570, height: 122 })).toBe(false);
    expect(compactSmall({ width: 180, height: 100 })).toBe(true);
    expect(compactSmall({ width: 400, height: 80 })).toBe(true);
  });
});

describe('end labels', () => {
  it('leaves labels that are far enough apart where they are', () => {
    expect(spreadLabels([10, 40, 80], 11)).toEqual([10, 40, 80]);
  });

  it('pushes close labels apart, keeping the order given', () => {
    const ys = spreadLabels([50, 45, 52], 10);
    const sorted = [...ys].sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(10);
    expect(sorted[2] - sorted[1]).toBeGreaterThanOrEqual(10);
    expect(ys[1]).toBeLessThan(ys[0]);
    expect(ys[0]).toBeLessThan(ys[2]);
  });

  it('stays inside its bounds, pushing back up from the bottom', () => {
    const ys = spreadLabels([95, 98, 99], 10, 0, 100);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect([...ys].sort((a, b) => a - b)).toEqual([80, 90, 100]);
  });

  it('spreads evenly when there is not room for all', () => {
    expect(spreadLabels([5, 5, 5], 10, 0, 10)).toEqual([0, 5, 10]);
  });
});

describe('gaps', () => {
  it('reads seconds and lapped cars, never NaN', () => {
    expect(parseGap(1.234)).toEqual({ seconds: 1.234 });
    expect(parseGap('+1 LAP')).toEqual({ laps: 1 });
    expect(parseGap('+2 LAPS')).toEqual({ laps: 2 });
    expect(parseGap('+12.5')).toEqual({ seconds: 12.5 });
    for (const v of [null, undefined, '', 'LAP', NaN, {}, '+? LAP']) expect(parseGap(v)).toBeNull();
    expect(gapSeconds('+1 LAP')).toBeNull();
    expect(gapSeconds(0)).toBe(0);
  });

  it('writes them as the tower shows them', () => {
    expect(formatGap({ seconds: 1.2 })).toBe('+1.200');
    expect(formatGap({ laps: 1 })).toBe('+1 LAP');
    expect(formatGap({ laps: 3 })).toBe('+3 LAPS');
    expect(formatGap(null)).toBe('');
    expect(formatLapTime(93.4561)).toBe('1:33.456');
    expect(formatLapTime(59.9999)).toBe('1:00.000');
    expect(formatLapTime(null)).toBe('');
    expect(formatLapTime(92.46, 1)).toBe('1:32.5');
    expect(formatLapTime(92, 0)).toBe('1:32');
  });

  it('counts tyre age from the stint', () => {
    expect(stintAge(17, 31, 0)).toBe(15);
    expect(stintAge(17, 17, 3)).toBe(4);
    expect(stintAge(1, null, null)).toBe(1);
    expect(['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET', 'UNKNOWN', null].map(compoundLetter).join('')).toBe('SMHIW??');
  });
});

const entry = (driver_number: number, name_acronym: string, team_name: string, team_colour: string | null): DriverEntry => ({
  driver_number,
  name_acronym,
  team_name,
  team_colour,
  broadcast_name: null,
  full_name: null,
  first_name: null,
  last_name: null,
  headshot_url: null,
  country_code: null,
});

describe('driver colours', () => {
  it('uses the team colour, and dashes the second driver of a team', () => {
    const styles = driverStyles([entry(4, 'NOR', 'McLaren', 'F47600'), entry(44, 'HAM', 'Ferrari', 'ED1131'), entry(81, 'PIA', 'McLaren', 'F47600')]);
    expect(styles.get(4)).toEqual({ number: 4, code: 'NOR', colour: '#F47600', dashed: false });
    expect(styles.get(81)?.dashed).toBe(true);
    expect(styles.get(44)?.dashed).toBe(false);
  });

  it('falls back when the roster has no colour', () => {
    expect(driverStyles([entry(1, 'VER', 'Red Bull', null)]).get(1)?.colour).toBe('#8a8a8a');
  });
});

const coverage = (timing: string, reason: string | null = null) =>
  ({
    state: 'ready',
    coverage: { datasets: { timing: { state: timing, reason }, telemetry: { state: 'absent', reason: null }, results: { state: 'complete', reason: null } } },
  }) as unknown as SessionDataView;

describe('frame messages', () => {
  it('says why session data is not there', () => {
    expect(dataMessage({ state: 'idle' }, ['timing'])).toBe('No session open');
    expect(dataMessage({ state: 'unsupported', reason: 'Before 2023' }, ['timing'])).toBe('Before 2023');
    expect(dataMessage({ state: 'loading', sessionKey: 1, coverage: null }, ['timing'])).toMatch(/Loading/);
    expect(dataMessage(coverage('failed', 'The archive refused the request'), ['timing'])).toBe('The archive refused the request');
    expect(dataMessage(coverage('absent'), ['timing'])).toBe('No timing data for this session');
    expect(dataMessage(coverage('absent'), ['telemetry'])).toBe('No telemetry data for this session');
  });

  it('lets a chart draw when what it needs is there, even in part', () => {
    expect(dataMessage(coverage('complete'), ['timing'])).toBeNull();
    expect(dataMessage(coverage('partial', 'Captured live from 14:02'), ['timing'])).toBeNull();
    expect(dataMessage(coverage('absent'), [])).toBeNull();
  });

  it('says when a query failed or has nothing yet', () => {
    expect(viewMessage([{ state: 'failed', reason: 'no such column: x' }])).toBe('The query failed: no such column: x');
    expect(viewMessage([{ state: 'loading' }])).toBe('');
    expect(viewMessage([{ state: 'ready', columns: [], rows: [] }])).toBe('No data yet');
    expect(viewMessage([{ state: 'ready', columns: ['a'], rows: [{ a: 1 }] }])).toBeNull();
  });
});

describe('laps', () => {
  const lap = (lap_number: number, track_status: string | null, more: Record<string, unknown> = {}) => ({
    lap_number,
    track_status,
    lap_duration: 92,
    is_pit_in_lap: 0,
    is_pit_out_lap: 0,
    ...more,
  });

  it('reads safety cars, virtual ones and red flags, but not yellows', () => {
    expect(['SCDeployed', 'VSCDeployed', 'VSCEnding', 'Red', 'Yellow', 'AllClear', null].map(neutralOf)).toEqual(['SC', 'VSC', 'VSC', 'RED', null, null, null]);
  });

  it('shades a lap when at least half the cars ran it neutralised, merging runs', () => {
    const rows = [
      lap(11, 'AllClear'), lap(11, 'SCDeployed'), lap(11, 'AllClear'),
      lap(12, 'SCDeployed'), lap(12, 'SCDeployed'), lap(12, 'Yellow'),
      lap(13, 'SCDeployed'), lap(13, 'SCDeployed'), lap(13, 'SCDeployed'),
      lap(14, 'AllClear'), lap(14, 'AllClear'), lap(14, 'AllClear'),
      lap(20, 'VSCDeployed'), lap(20, 'VSCEnding'), lap(21, 'Red'), lap(21, 'Red'),
    ];
    expect(neutralBands(rows)).toEqual([
      { first: 12, last: 13, kind: 'SC' },
      { first: 20, last: 20, kind: 'VSC' },
      { first: 21, last: 21, kind: 'RED' },
    ]);
    expect(neutralBands([])).toEqual([]);
  });

  it('counts a lap as clean only when it shows pace', () => {
    expect(isCleanLap(lap(5, 'AllClear'))).toBe(true);
    expect(isCleanLap(lap(1, 'AllClear'))).toBe(false);
    expect(isCleanLap(lap(5, 'Yellow'))).toBe(false);
    expect(isCleanLap(lap(5, null))).toBe(false);
    expect(isCleanLap(lap(5, 'AllClear', { is_pit_in_lap: 1 }))).toBe(false);
    expect(isCleanLap(lap(5, 'AllClear', { is_pit_out_lap: 1 }))).toBe(false);
    expect(isCleanLap(lap(5, 'AllClear', { lap_duration: null }))).toBe(false);
  });

  it('counts the tyre age as the tower does, without the lap in progress', () => {
    expect(tyreAgeNow({ tyre_age: 5, lap_duration: 92 })).toBe(5);
    expect(tyreAgeNow({ tyre_age: 5, lap_duration: null })).toBe(4);
    expect(tyreAgeNow({ tyre_age: 0, lap_duration: null })).toBe(0);
    expect(tyreAgeNow({ tyre_age: null })).toBeNull();
  });

  it('takes medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('keeps racing pace, fuel effect included, and drops a spin', () => {
    const race = [95, 94.6, 94.2, 93.8, 93.5, 93.2, 93, 92.8, 92.6, 104];
    expect(paceRange(race)).toEqual([92.6, 95]);
    expect(paceRange([90, 90.2, 90.1])).toEqual([90, 90.2]);
    expect(paceRange([])).toBeNull();
  });

  it('ends the lap axis on the distance', () => {
    expect(axisLaps(31, 57)).toBe(57);
    expect(axisLaps(12, null)).toBe(12);
    expect(axisLaps(0, null)).toBe(1);
    expect(lapTicks(57, 300)).toEqual([10, 20, 30, 40, 50, 57]);
    expect(lapTicks(52, 300)).toEqual([10, 20, 30, 40, 52]);
    expect(lapTicks(5, 400)).toEqual([1, 2, 3, 4, 5]);
    expect(lapTicks(70, 100)).toEqual([70]);
  });
});

describe('circuitMessage', () => {
  it('waits for the circuit, says why there is none, and lets a stale copy serve', () => {
    expect(circuitMessage({ state: 'loading' })).toBe('Loading the circuit…');
    expect(circuitMessage({ state: 'failed', reason: 'HTTP 503' })).toBe('No circuit data. HTTP 503');
    const ready = { circuitKey: 9, name: 'Austin', refreshedAt: 1, outline: { x: [], y: [] }, corners: [], rotation: 0, pitLoss: { normal: 20, safetyCar: null, virtualSafetyCar: null } };
    expect(circuitMessage({ state: 'ready', reason: 'HTTP 503', ...ready })).toBeNull();
  });
});

describe('track geometry', () => {
  const square = { x: [0, 100, 100, 0], y: [0, 0, 50, 50] };

  it('turns anticlockwise with y up', () => {
    const [x, y] = rotate(10, 0, 90);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(10);
  });

  it('fits the outline to the box keeping its aspect, centred, y up', () => {
    const fit = fitOutline(square, 0, { left: 0, top: 0, width: 200, height: 200 });
    expect(fit.scale).toBe(2);
    expect(fit(0, 0)).toEqual([0, 150]);
    expect(fit(100, 50)).toEqual([200, 50]);
    // Turned a quarter, the long side stands up, centred across: (100, 0) goes to the top right.
    const turned = fitOutline(square, 90, { left: 0, top: 0, width: 200, height: 200 });
    expect(turned.scale).toBe(2);
    const [x, y] = turned(100, 0);
    expect(x).toBeCloseTo(150);
    expect(y).toBeCloseTo(0);
  });

  it('measures the outline as a closed line', () => {
    expect(outlineLength(square)).toBe(300);
  });

  it('projects points onto the outline, as distance along it and off it', () => {
    const project = projector(square);
    expect(project(50, -3)).toEqual({ s: 50, off: 3 });
    expect(project(103, 25)).toEqual({ s: 125, off: 3 });
    // Back along the closing side, from (0, 50) to (0, 0).
    expect(project(-1, 10)).toEqual({ s: 290, off: 1 });
  });

  it('takes a lap from positions between two crossings of the line, interpolated', () => {
    // Round the 300-unit square (30 m) at 10 units a second, starting at 280 units: crossings at 2 s and 32 s.
    const round = (u: number): { x: number; y: number } => {
      const s = ((u % 300) + 300) % 300;
      if (s < 100) return { x: s, y: 0 };
      if (s < 150) return { x: 100, y: s - 100 };
      if (s < 250) return { x: 250 - s, y: 50 };
      return { x: 0, y: 300 - s };
    };
    const positions = Array.from({ length: 36 }, (_, i) => ({ date: i * 1000 + 500, ...round(285 + i * 10) }));
    const lap = lineCrossings(positions, square, 2000)!;
    expect(lap.start).toBeCloseTo(2000);
    expect(lap.end).toBeCloseTo(32_000);
    // The crossing nearest the time given, so a timed start a little late still finds it.
    expect(lineCrossings(positions, square, 2400)!.start).toBeCloseTo(2000);
    // Too short a window for a whole lap.
    expect(lineCrossings(positions.slice(0, 10), square, 2000)).toBeNull();
  });

  it('integrates speed over the lap, holding the end samples to its ends', () => {
    // 36 km/h is 10 m/s: a 10 s lap of constant speed is 100 m.
    const samples = [2000, 4000, 6000, 8000].map((date) => ({ date, speed: 36 }));
    const lap = lapDistance([...samples, { date: 20_000, speed: 300 }], 0, 10_000)!;
    expect(lap[0]).toEqual({ t: 0, d: 0, speed: 36 });
    expect(lap.at(-1)!.t).toBe(10);
    expect(lap.at(-1)!.d).toBeCloseTo(100);
    // Scaled to a known length, every distance stretches the same.
    const scaled = lapDistance(samples, 0, 10_000, 110)!;
    expect(scaled.at(-1)!.d).toBeCloseTo(110);
    expect(scaled[1].d).toBeCloseTo(22);
    expect(lapDistance([], 0, 10_000)).toBeNull();
  });

  it('reads the time at a distance between samples', () => {
    const lap = [
      { t: 0, d: 0 },
      { t: 2, d: 10 },
      { t: 4, d: 30 },
    ];
    expect(timeAt(lap, 5)).toBe(1);
    expect(timeAt(lap, 20)).toBe(3);
    expect(timeAt(lap, 31)).toBeNull();
  });

  it('runs the difference along the lap, ending at the lap time difference', () => {
    const fast = [
      { t: 0, d: 0 },
      { t: 10, d: 100 },
    ];
    const slow = [
      { t: 0, d: 0 },
      { t: 12, d: 100 },
    ];
    const delta = deltaAlong(fast, slow, 4);
    expect(delta.map((p) => p.d)).toEqual([0, 25, 50, 75, 100]);
    expect(delta[2].delta).toBeCloseTo(1);
    expect(delta.at(-1)!.delta).toBeCloseTo(2);
    expect(deltaAlong([], slow)).toEqual([]);
  });

  it('draws the delta straight through slow corners, keeping the change across them and the ends', () => {
    // A spike at 200 to 210 m, inside a slow corner from 180 to 230 m, and a real 0.1 s lost there.
    const delta = Array.from({ length: 41 }, (_, i) => ({ d: i * 10, delta: (i >= 23 ? 0.1 : 0) + (i === 20 || i === 21 ? 0.3 : 0) }));
    const bridged = bridgeSlow(delta, (d) => d >= 180 && d <= 230);
    expect(bridged[17].delta).toBe(0);
    expect(bridged[20].delta).toBeCloseTo(0.3 / 7);
    expect(bridged[24].delta).toBeCloseTo(0.1);
    expect(Math.max(...bridged.map((p) => p.delta))).toBeCloseTo(0.1);
    expect(bridgeSlow(delta, () => true)[0]).toEqual(delta[0]);
    expect(bridgeSlow(delta, () => true)[40]).toEqual(delta[40]);
    expect(bridgeSlow([], () => true)).toEqual([]);
  });
});
