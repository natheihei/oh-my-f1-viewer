import { describe, expect, it } from 'vitest';
import type { DriverEntry, SessionDataView } from '../../../host';
import { driverStyles } from './colors';
import { spreadLabels } from './labels';
import { linear, niceCeil, niceStep, ticks } from './scale';
import { dataMessage, viewMessage } from './status';
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
