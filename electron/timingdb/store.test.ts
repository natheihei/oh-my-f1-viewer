import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestResults, ingestTelemetry, ingestTiming, isFinal, LiveCapture } from './ingest';
import { timingRouter, type SessionMeta } from './processors';
import { TimingStore } from './store';
import { SQL_TABLES } from '../../shared/sessionData';
import { DERIVED_VIEWS, sqlColumns, TABLE_BY_NAME } from './schema';

const META: SessionMeta = { meetingKey: 100, sessionKey: 200, isRace: true };
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY = 24 * 3600 * 1000;

const offset = (ms: number) => new Date(ms).toISOString().slice(11, 23);
const utc = (ms: number) => new Date(BASE + ms).toISOString();
const stream = (records: Array<[number, unknown]>) => `﻿${records.map(([ms, data]) => `${offset(ms)}${JSON.stringify(data)}`).join('\r\n')}\r\n`;
const compressed = (records: Array<[number, unknown]>) =>
  records.map(([ms, data]) => `${offset(ms)}"${zlib.deflateRawSync(Buffer.from(JSON.stringify(data))).toString('base64')}"`).join('\r\n');

/**
 * A short race: lights out at 1m, one lap in 1m30s, a stop on lap 2, a finish at 10m. Yellow on lap 1,
 * a VSC then a safety car on lap 2, and a red flag on lap 4. The distance is cut from 5 laps to 3 at 5m.
 */
function raceFiles(): Record<string, string> {
  return {
    SessionInfo: stream([[0, { Key: 200, Type: 'Race', Name: 'Race', Path: '2026/x/', Meeting: { Key: 100 } }]]),
    ExtrapolatedClock: stream([[0, { Utc: utc(0), Remaining: '02:00:00', Extrapolating: false }]]),
    DriverList: stream([[0, { '1': { RacingNumber: '1', FullName: 'Driver One', Tla: 'ONE', TeamName: 'A' } }]]),
    SessionData: stream([
      [60_000, { StatusSeries: { '0': { Utc: utc(60_000), SessionStatus: 'Started' } } }],
      [590_000, { StatusSeries: { '1': { Utc: utc(590_000), SessionStatus: 'Finished' } } }],
      [600_000, { StatusSeries: { '2': { Utc: utc(600_000), SessionStatus: 'Finalised' } } }],
    ]),
    TimingAppData: stream([
      [1_000, { Lines: { '1': { Stints: [{ Compound: 'SOFT', StartLaps: 0, TotalLaps: 0 }] } } }],
      [240_000, { Lines: { '1': { Stints: { '1': { Compound: 'HARD', StartLaps: 0, TotalLaps: 0 } } } } }],
    ]),
    TimingData: stream([
      [50_000, { Lines: { '1': { Line: 3 } } }],
      [61_000, { Lines: { '1': { Sectors: { '0': { Value: '' } } } } }],
      [150_000, { Lines: { '1': { NumberOfLaps: 1, Line: 2 } } }],
      [151_000, { Lines: { '1': { LastLapTime: { Value: '1:29.000' } } } }],
      [240_000, { Lines: { '1': { NumberOfLaps: 2 } } }],
      [241_000, { Lines: { '1': { LastLapTime: { Value: '1:31.000' } } } }],
      // F1 sends `PitOut: false` too, which isn't an out lap.
      [155_000, { Lines: { '1': { PitOut: false } } }],
      [245_000, { Lines: { '1': { PitOut: true } } }],
      [330_000, { Lines: { '1': { NumberOfLaps: 3, Line: 1 } } }],
    ]),
    TrackStatus: stream([
      [0, { Status: '1', Message: 'AllClear' }],
      [100_000, { Status: '2', Message: 'Yellow' }],
      [110_000, { Status: '1', Message: 'AllClear' }],
      [200_000, { Status: '6', Message: 'VSCDeployed' }],
      [230_000, { Status: '4', Message: 'SCDeployed' }],
      [260_000, { Status: '1', Message: 'AllClear' }],
      [340_000, { Status: '5', Message: 'Red' }],
    ]),
    LapCount: stream([
      [2_000, { CurrentLap: 1, TotalLaps: 5 }],
      [150_000, { CurrentLap: 2 }],
      [240_000, { CurrentLap: 3 }],
      [300_000, { TotalLaps: 3 }],
    ]),
    DriverRaceInfo: stream([[150_000, { '1': { Gap: '+1.500', Interval: '+0.500' } }]]),
    // Reports a stop at 200s, but the message only arrives at 235s.
    PitStopSeries: stream([[235_000, { PitTimes: { '1': [{ Timestamp: utc(200_000), PitStop: { Lap: '2', PitLaneTime: '20.0', PitStopTime: '2.5' } }] } }]]),
    RaceControlMessages: stream([[100_000, { Messages: [{ Utc: utc(90_000), Category: 'Flag', Flag: 'YELLOW', Message: 'YELLOW' }] }]]),
    ChampionshipPrediction: stream([
      [120_000, { Drivers: { '1': { CurrentPoints: 10, PredictedPoints: 20, CurrentPosition: 2, PredictedPosition: 2 } } }],
      [300_000, { Drivers: { '1': { PredictedPoints: 35, PredictedPosition: 1 } } }],
    ]),
  };
}

describe('session database', () => {
  let dir: string;
  let store: TimingStore;
  const sql = (query: string, playhead: number, params: unknown[] = []) => store.sql(META.sessionKey, playhead, query, params).rows;
  const at = (ms: number) => BASE + ms;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'omfv-timingdb-'));
    store = new TimingStore(path.join(dir, 'test.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ingest = (now = BASE + DAY) => ingestTiming(store, META, { files: raceFiles(), failed: [] }, BASE + 2 * 3600 * 1000, now);

  describe('visible_from on archived data', () => {
    beforeEach(() => ingest());

    it('shows nothing before the feed has said it', () => {
      expect(sql('SELECT * FROM position', at(49_999))).toEqual([]);
      expect(sql('SELECT position FROM position', at(50_000))).toEqual([expect.objectContaining({ position: 3 })]);
    });

    it("goes by when a message arrived, not the time it reports", () => {
      expect(sql('SELECT * FROM pit', at(200_000))).toEqual([]);
      expect(sql('SELECT * FROM pit', at(234_999))).toEqual([]);
      expect(sql('SELECT date, lane_duration FROM pit', at(235_000))).toEqual([{ date: BASE + 200_000, lane_duration: 20 }]);
      expect(sql("SELECT date FROM race_control WHERE category = 'Flag'", at(95_000))).toEqual([]);
      expect(sql("SELECT date FROM race_control WHERE category = 'Flag'", at(100_000))).toEqual([{ date: BASE + 90_000 }]);
    });

    it('reads a lap as it stood, without its time before that was known', () => {
      expect(sql('SELECT lap_number, lap_duration FROM laps WHERE lap_number = 2', at(150_500))).toEqual([{ lap_number: 2, lap_duration: null }]);
      expect(sql('SELECT lap_duration FROM laps WHERE lap_number = 1', at(150_500))[0].lap_duration).not.toBe(89);
      expect(sql('SELECT lap_duration FROM laps WHERE lap_number = 1', at(151_000))).toEqual([{ lap_duration: 89 }]);
    });

    it("doesn't reveal a pit stop through a stint's laps", () => {
      expect(sql('SELECT stint_number, lap_end FROM stints', at(120_000))).toEqual([{ stint_number: 1, lap_end: 1 }]);
      expect(sql('SELECT stint_number FROM stints ORDER BY stint_number', at(239_999))).toEqual([{ stint_number: 1 }]);
      expect(sql('SELECT stint_number, compound FROM stints ORDER BY stint_number', at(240_000)).at(-1)).toEqual({ stint_number: 2, compound: 'HARD' });
    });

    it('never returns two versions of one row', () => {
      const laps = sql('SELECT driver_number, lap_number, COUNT(*) AS n FROM laps GROUP BY 1, 2', at(600_000));
      expect(laps.length).toBeGreaterThan(1);
      expect(laps.every((row) => row.n === 1)).toBe(true);
    });

    it('moves backward as well as forward', () => {
      expect(sql('SELECT COUNT(*) AS n FROM position', at(600_000))[0].n).toBe(3);
      expect(sql('SELECT COUNT(*) AS n FROM position', at(100_000))[0].n).toBe(1);
      expect(sql('SELECT COUNT(*) AS n FROM position', at(600_000))[0].n).toBe(3);
    });

    it('shows standings as they stood, not the final ones', () => {
      const standings = (playhead: number) => sql('SELECT driver_number, points_current, position_current FROM championship_drivers ORDER BY position_current', playhead);
      expect(standings(at(100_000))).toEqual([]);
      expect(standings(at(200_000))[0]).toMatchObject({ points_current: 20, position_current: 2 });
      expect(standings(at(300_000))[0]).toMatchObject({ points_current: 35, position_current: 1 });
    });

    it('gives the roster through SQL as well as the objects, the same rows', () => {
      expect(sql('SELECT driver_number, full_name, name_acronym, team_name FROM drivers', at(600_000))).toEqual([
        { driver_number: 1, full_name: 'Driver One', name_acronym: 'ONE', team_name: 'A' },
      ]);
      expect(store.sessionObjects(META.sessionKey, at(600_000)).drivers).toMatchObject([{ driver_number: 1, full_name: 'Driver One' }]);
    });

    it("records where the feed's timeline sits, to place video frames on it", () => {
      expect(store.detail(META.sessionKey, 'timing').clock).toEqual({ feedBaseUtc: BASE, clockStartOffsetMs: null, scheduledStartOffsetMs: null, durationMs: 600_000 });
    });

    it('keeps F1\'s words for the track status, each from when it was sent', () => {
      expect(sql('SELECT status FROM track_status ORDER BY date', at(99_999)).map((r) => r.status)).toEqual(['AllClear']);
      expect(sql('SELECT date, status FROM track_status ORDER BY date', at(230_000)).at(-1)).toEqual({ date: BASE + 230_000, status: 'SCDeployed' });
      expect(sql('SELECT COUNT(*) AS n FROM track_status', at(600_000))[0].n).toBe(7);
    });

    it('gives the lap count as of the playhead, with the distance from the start', () => {
      expect(store.sessionObjects(META.sessionKey, at(1_999)).lapCount).toBeNull();
      expect(store.sessionObjects(META.sessionKey, at(2_000)).lapCount).toEqual({ current: 1, total: 5 });
      expect(store.sessionObjects(META.sessionKey, at(239_999)).lapCount).toEqual({ current: 2, total: 5 });
      expect(store.sessionObjects(META.sessionKey, at(299_999)).lapCount).toEqual({ current: 3, total: 5 });
      expect(store.sessionObjects(META.sessionKey, at(300_000)).lapCount).toEqual({ current: 3, total: 3 });
    });

    it('takes a flag of PitOut: false as no out lap', () => {
      expect(sql('SELECT lap_number, is_pit_out_lap FROM laps ORDER BY lap_number', at(600_000))).toEqual([
        { lap_number: 1, is_pit_out_lap: 0 },
        { lap_number: 2, is_pit_out_lap: 0 },
        { lap_number: 3, is_pit_out_lap: 1 },
        { lap_number: 4, is_pit_out_lap: 0 },
      ]);
    });

    it('keeps each session to itself', () => {
      expect(store.sql(999, at(600_000), 'SELECT * FROM position').rows).toEqual([]);
    });
  });

  describe('lap_summary', () => {
    beforeEach(() => ingest());
    const laps = (playhead: number, columns = 'lap_number, date_end, position, gap_to_leader') =>
      sql(`SELECT ${columns} FROM lap_summary ORDER BY lap_number`, at(playhead));

    it('ends a lap where the next starts, with position and gaps from the line', () => {
      expect(laps(600_000)).toEqual([
        { lap_number: 1, date_end: BASE + 150_000, position: 2, gap_to_leader: 1.5 },
        { lap_number: 2, date_end: BASE + 240_000, position: 2, gap_to_leader: 1.5 },
        { lap_number: 3, date_end: BASE + 330_000, position: 1, gap_to_leader: 1.5 },
        { lap_number: 4, date_end: null, position: 1, gap_to_leader: 1.5 },
      ]);
    });

    it('only has the laps the playhead has reached, and no end before the next lap starts', () => {
      expect(laps(149_999)).toEqual([]);
      expect(laps(150_000)).toEqual([
        { lap_number: 1, date_end: BASE + 150_000, position: 2, gap_to_leader: 1.5 },
        { lap_number: 2, date_end: null, position: 2, gap_to_leader: 1.5 },
      ]);
      expect(laps(239_999).map((r) => [r.lap_number, r.date_end])).toEqual([
        [1, BASE + 150_000],
        [2, null],
      ]);
    });

    it('marks the in-lap once the stop is known, and the lap after as the out lap', () => {
      const flags = (playhead: number) => laps(playhead, 'lap_number, is_pit_in_lap, is_pit_out_lap');
      expect(flags(234_999)).toEqual([
        { lap_number: 1, is_pit_in_lap: 0, is_pit_out_lap: 0 },
        { lap_number: 2, is_pit_in_lap: 0, is_pit_out_lap: 0 },
      ]);
      expect(flags(600_000)).toEqual([
        { lap_number: 1, is_pit_in_lap: 0, is_pit_out_lap: 0 },
        { lap_number: 2, is_pit_in_lap: 1, is_pit_out_lap: 0 },
        { lap_number: 3, is_pit_in_lap: 0, is_pit_out_lap: 1 },
        { lap_number: 4, is_pit_in_lap: 0, is_pit_out_lap: 0 },
      ]);
    });

    it('gives each lap the worst track status during it, counting the one it started under', () => {
      const status = (playhead: number) => laps(playhead, 'lap_number, track_status').map((r) => r.track_status);
      expect(status(600_000)).toEqual(['Yellow', 'SCDeployed', 'SCDeployed', 'Red']);
      // The lap in progress has only what's happened so far.
      expect(status(229_999)).toEqual(['Yellow', 'VSCDeployed']);
      expect(status(339_999)).toEqual(['Yellow', 'SCDeployed', 'SCDeployed', 'AllClear']);
    });

    it('marks the lap a car retired on, only once the feed has said so', () => {
      const files = raceFiles();
      files.DriverRaceInfo = stream([
        [150_000, { '1': { Gap: '+1.500', Interval: '+0.500' } }],
        [335_000, { '1': { Gap: '', Interval: '', IsOut: true } }],
      ]);
      ingestTiming(store, META, { files, failed: [] }, BASE + 2 * 3600 * 1000, BASE + DAY);
      const out = (playhead: number) => laps(playhead, 'lap_number, is_out').filter((r) => r.is_out).map((r) => r.lap_number);
      expect(laps(600_000, 'lap_number, is_out').map((r) => r.is_out)).toEqual([0, 0, 0, 1]);
      expect(out(334_999)).toEqual([]);
      expect(out(335_000)).toEqual([4]);
    });

    it('carries the stint, compound and the age of the set', () => {
      expect(laps(600_000, 'lap_number, stint_number, compound, tyre_age')[0]).toEqual({ lap_number: 1, stint_number: 1, compound: 'SOFT', tyre_age: 1 });
    });

    it('is a view consumers can read but not reach past', () => {
      expect(() => sql('SELECT * FROM lap_summary', at(600_000))).not.toThrow();
      expect(sql('SELECT * FROM lap_summary', at(49_999))).toEqual([]);
    });

  });

  describe('what SQL can read', () => {
    const reported = (name: string) => store.tables.find((t) => t.name === name);

    it('is the list of tables in SQL_TABLES, in the same order', () => {
      expect(store.tables.map((t) => t.name)).toEqual([...SQL_TABLES]);
    });

    it('says what the championship columns mean', () => {
      expect(reported('championship_drivers')?.about).toMatch(/projection/);
      expect(reported('championship_teams')?.columns).not.toContain('team_key');
    });

    it('builds every derived view from the list, after the views it reads', () => {
      for (const view of DERIVED_VIEWS) {
        expect(reported(view.name)).toMatchObject({ about: view.about });
        expect(() => sql(`SELECT * FROM ${view.name}`, at(600_000))).not.toThrow();
      }
    });

    it("reports a filter view's columns from its definition, and no about", () => {
      expect(reported('laps')).toEqual({ name: 'laps', columns: sqlColumns(TABLE_BY_NAME.get('laps')!) });
      expect(reported('race_control')!.columns).not.toContain('row_key');
    });

    it("reports lap_summary's columns from its SQL, with no visible_from", () => {
      expect(reported('lap_summary')!.columns).toEqual([
        'session_key',
        'meeting_key',
        'driver_number',
        'lap_number',
        'date_start',
        'date_end',
        'lap_duration',
        'duration_sector_1',
        'duration_sector_2',
        'duration_sector_3',
        'position',
        'gap_to_leader',
        'interval',
        'stint_number',
        'compound',
        'tyre_age',
        'is_pit_in_lap',
        'is_pit_out_lap',
        'track_status',
        'is_out',
      ]);
    });

    it('reports the columns a query gets back', () => {
      ingest();
      for (const { name, columns } of store.tables) expect(store.sql(META.sessionKey, at(600_000), `SELECT * FROM ${name} LIMIT 0`).columns).toEqual(columns);
    });
  });

  it('turns track status and lap count messages into rows', () => {
    const router = timingRouter(META);
    const rows = (topic: string, content: unknown) => router.process({ topic, content, time: BASE }).map((e) => [e.table, e.row]);
    const key = { meeting_key: 100, session_key: 200 };
    expect(rows('TrackStatus', { Status: '6', Message: 'VSCDeployed' })).toEqual([['track_status', { ...key, date: BASE, status: 'VSCDeployed' }]]);
    expect(rows('TrackStatus', { Status: '1' })).toEqual([]);
    expect(rows('LapCount', { CurrentLap: 1, TotalLaps: 71 })).toEqual([['lap_count', { ...key, current_lap: 1, total_laps: 71 }]]);
    // Later messages carry only the lap: the distance stays.
    expect(rows('LapCount', { CurrentLap: 2 })).toEqual([['lap_count', { ...key, current_lap: 2, total_laps: 71 }]]);
  });

  describe('retirements', () => {
    const run = (messages: Array<{ topic: string; content: unknown; snapshot?: boolean }>) => {
      const router = timingRouter(META);
      router.process({ topic: 'TimingAppData', content: { Lines: { '1': { Stints: [{ Compound: 'SOFT' }] } } }, time: BASE });
      return messages.flatMap((m, i) => router.process({ ...m, time: BASE + i + 1 })).filter((e) => e.table === 'laps').map((e) => e.row);
    };
    const lap = (n: number) => ({ topic: 'TimingData', content: { Lines: { '1': { NumberOfLaps: n } } } });

    it('marks the lap in progress when DriverRaceInfo says IsOut, and no lap after', () => {
      const rows = run([lap(4), { topic: 'DriverRaceInfo', content: { '1': { IsOut: false } } }, { topic: 'DriverRaceInfo', content: { '1': { IsOut: true } } }]);
      expect(rows.filter((r) => r.is_out).map((r) => r.lap_number)).toEqual([5]);
      expect(rows.at(-1)).toMatchObject({ lap_number: 5, is_out: true });
    });

    it("takes TimingData's Retired, but not Stopped", () => {
      expect(run([lap(4), { topic: 'TimingData', content: { Lines: { '1': { Stopped: true } } } }]).some((r) => r.is_out)).toBe(false);
      expect(run([lap(4), { topic: 'TimingData', content: { Lines: { '1': { Retired: true, Stopped: true } } } }]).at(-1)).toMatchObject({ lap_number: 5, is_out: true });
    });

    it('marks a car out in a snapshot on the lap the snapshot puts it on', () => {
      const rows = run([
        { topic: 'DriverRaceInfo', content: { '1': { IsOut: true } }, snapshot: true },
        { topic: 'TimingData', content: { Lines: { '1': { NumberOfLaps: 20 } } }, snapshot: true },
      ]);
      expect(rows).toEqual([expect.objectContaining({ lap_number: 21, is_out: true })]);
    });
  });

  it('has no lap count in a session without one', () => {
    const files = raceFiles();
    delete files.LapCount;
    ingestTiming(store, META, { files, failed: [] }, BASE, BASE + DAY);
    expect(store.sessionObjects(META.sessionKey, at(600_000)).lapCount).toBeNull();
  });

  describe('results', () => {
    const grid = [{ driver_number: 1, position: 3, lap_duration: 80 }];
    const result = [{ driver_number: 1, position: 1, number_of_laps: 3, points: 25, dnf: false, dns: false, dsq: false, duration: 300, gap_to_leader: 0 }];

    it('shows the grid from the start of the feed, and the result only once the session has finished', () => {
      ingest();
      ingestResults(store, META, { grid, result, final: true, failed: false }, BASE + DAY);
      const gridAt = (playhead: number) => sql('SELECT driver_number, position, lap_duration FROM starting_grid', playhead);
      const resultAt = (playhead: number) => sql('SELECT driver_number, position, points, dnf, duration FROM session_result', playhead);
      expect(gridAt(at(-1))).toEqual([]);
      expect(gridAt(at(100_000))).toEqual(grid);
      expect(resultAt(at(599_999))).toEqual([]);
      expect(resultAt(at(600_000))).toEqual([{ driver_number: 1, position: 1, points: 25, dnf: 0, duration: 300 }]);
    });

    it('stores no result for a session still in progress', () => {
      ingestTiming(store, META, { files: raceFiles(), failed: ['WeatherData'] }, null, BASE + DAY);
      ingestResults(store, META, { grid, result, final: true, failed: false }, BASE + DAY);
      expect(sql('SELECT * FROM session_result', at(10 * DAY))).toEqual([]);
      expect(store.isComplete(META.sessionKey, 'results')).toBe(false);
    });
  });

  describe('marking an ingestion complete', () => {
    it('is complete once everything arrived and the feed says the session is over', () => {
      ingest();
      expect(store.isComplete(META.sessionKey, 'timing')).toBe(true);
      expect(store.coverage(META.sessionKey).datasets.timing.state).toBe('complete');
    });

    it("isn't complete when a feed failed to download, and says so", () => {
      ingestTiming(store, META, { files: raceFiles(), failed: ['WeatherData'] }, BASE, BASE + 30 * DAY);
      expect(store.isComplete(META.sessionKey, 'timing')).toBe(false);
      expect(store.coverage(META.sessionKey).datasets.timing).toEqual({ state: 'partial', reason: expect.stringContaining('could not be downloaded') });
    });

    it('accepts a feed that just doesn\'t exist for this session', () => {
      const files = raceFiles();
      delete files.ChampionshipPrediction;
      ingestTiming(store, META, { files, failed: [] }, BASE, BASE + DAY);
      expect(store.isComplete(META.sessionKey, 'timing')).toBe(true);
      expect(store.coverage(META.sessionKey).missingFeeds).toContain('ChampionshipPrediction');
    });

    it('has a fallback for archives that never report the end', () => {
      expect(isFinal([], true, null, 0)).toBe(true);
      expect(isFinal([], false, BASE, BASE + DAY)).toBe(false);
      expect(isFinal([], false, BASE, BASE + 4 * DAY)).toBe(true);
      expect(isFinal(['TimingData'], true, BASE, BASE + 4 * DAY)).toBe(false);
    });

    it('fails with a reason when there is no timing, instead of marking it done', () => {
      ingestTiming(store, META, { files: {}, failed: [] }, BASE, BASE + DAY);
      expect(store.isComplete(META.sessionKey, 'timing')).toBe(false);
      expect(store.coverage(META.sessionKey).datasets.timing.state).toBe('failed');
    });

    it('replaces rather than adds when ingested again', () => {
      ingest();
      ingest();
      expect(sql('SELECT COUNT(*) AS n FROM position', at(600_000))[0].n).toBe(3);
    });

    it('marks each dataset by itself', () => {
      ingest();
      expect(store.isComplete(META.sessionKey, 'timing')).toBe(true);
      expect(store.isComplete(META.sessionKey, 'telemetry')).toBe(false);
      expect(store.isComplete(META.sessionKey, 'results')).toBe(false);
    });
  });

  describe('telemetry', () => {
    it('decompresses both feeds and shows each sample from its own date, before the batch it came in arrived', async () => {
      ingest();
      const files = {
        'CarData.z': compressed([[60_000, { Entries: [{ Utc: utc(59_000), Cars: { '1': { Channels: { '0': 11000, '2': 300, '3': 8, '4': 100, '5': 0, '45': 12 } } } }] }]]),
        'Position.z': compressed([[60_000, { Position: [{ Timestamp: utc(59_500), Entries: { '1': { X: 1, Y: 2, Z: 3 } } }] }]]),
      };
      await ingestTelemetry(store, META, { files, failed: [] }, BASE, BASE + DAY, async () => {});
      // Both were sent at 60s, in one batch each, about things at 59s and 59.5s.
      expect(sql('SELECT * FROM car_data', at(58_999))).toEqual([]);
      expect(sql('SELECT date, speed, n_gear FROM car_data', at(59_000))).toEqual([{ date: BASE + 59_000, speed: 300, n_gear: 8 }]);
      expect(sql('SELECT * FROM location', at(59_499))).toEqual([]);
      expect(sql('SELECT date, x FROM location', at(59_500))).toEqual([{ date: BASE + 59_500, x: 1 }]);
      // Every other table still waits for its message: the pit stop at 200s isn't known until 235s.
      expect(sql('SELECT * FROM pit', at(234_999))).toEqual([]);
      expect(store.isComplete(META.sessionKey, 'telemetry')).toBe(true);
    });
  });

  describe('live capture', () => {
    const snapshot = (receivedAt: number) => [
      { topic: 'SessionInfo', data: { Key: 200, Type: 'Race', Path: '2026/x/' }, snapshot: true, receivedAt },
      { topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 20, Line: 4, LastLapTime: { Value: '1:30.000' } } } }, snapshot: true, receivedAt },
      { topic: 'TimingAppData', data: { Lines: { '1': { Stints: [{ Compound: 'SOFT', StartLaps: 0, TotalLaps: 15 }, { Compound: 'HARD', StartLaps: 0, TotalLaps: 5 }] } } }, snapshot: true, receivedAt },
    ];

    it('joins mid-race at the lap in progress, with no made-up earlier laps', () => {
      const capture = new LiveCapture(store, META, BASE);
      capture.append(snapshot(BASE));
      const laps = sql('SELECT lap_number, lap_duration FROM laps', BASE);
      expect(laps).toEqual([{ lap_number: 21, lap_duration: null }]);
    });

    it('gives the finished stints their laps from the snapshot', () => {
      new LiveCapture(store, META, BASE).append(snapshot(BASE));
      expect(sql('SELECT lap_start, lap_end, compound FROM stints ORDER BY stint_number', BASE)[0]).toEqual({ lap_start: 1, lap_end: 15, compound: 'SOFT' });
    });

    it('carries on with laps after joining', () => {
      const capture = new LiveCapture(store, META, BASE);
      capture.append(snapshot(BASE));
      capture.append([{ topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 21 } } }, ts: utc(90_000), receivedAt: BASE + 90_500 }]);
      capture.append([{ topic: 'TimingData', data: { Lines: { '1': { LastLapTime: { Value: '1:31.000' } } } }, ts: utc(91_000), receivedAt: BASE + 91_500 }]);
      expect(sql('SELECT lap_number, date_start, lap_duration FROM laps ORDER BY lap_number', BASE + 92_000)).toEqual([
        { lap_number: 21, date_start: null, lap_duration: 91 },
        { lap_number: 22, date_start: BASE + 90_000, lap_duration: null },
      ]);
    });

    it('holds what arrived back until the video reaches it, whatever time the feed puts on it', () => {
      const capture = new LiveCapture(store, META, BASE);
      capture.append([{ topic: 'TimingData', data: { Lines: { '1': { Line: 1 } } }, ts: utc(0), receivedAt: BASE + 2_000 }]);
      expect(sql('SELECT * FROM position', BASE + 1_999)).toEqual([]);
      expect(sql('SELECT date FROM position', BASE + 2_000)).toEqual([{ date: BASE }]);
    });

    it('is never marked complete, so the archive replaces it later', () => {
      new LiveCapture(store, META, BASE).append(snapshot(BASE));
      expect(store.isComplete(META.sessionKey, 'timing')).toBe(false);
      expect(store.coverage(META.sessionKey).source).toBe('live');
      ingest();
      expect(store.isComplete(META.sessionKey, 'timing')).toBe(true);
      expect(store.coverage(META.sessionKey).source).toBe('archive');
      expect(store.coverage(META.sessionKey).capturedFrom).toBeNull();
      expect(sql('SELECT lap_number FROM laps WHERE lap_number = 21', at(600_000))).toEqual([]);
    });

    it('rebuilds from what it kept when the app restarts mid-session', () => {
      const first = new LiveCapture(store, META, BASE);
      first.append(snapshot(BASE));
      first.append([{ topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 21 } } }, receivedAt: BASE + 90_000 }]);
      const second = new LiveCapture(store, META, BASE + 100_000);
      second.append([{ topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 22 } } }, receivedAt: BASE + 180_000 }]);
      expect(sql('SELECT lap_number FROM laps ORDER BY lap_number', BASE + 180_000).map((row) => row.lap_number)).toEqual([21, 22, 23]);
    });

    it('records gaps while the connection is down', () => {
      new LiveCapture(store, META, BASE).append(snapshot(BASE));
      store.openGap(META.sessionKey, BASE + 10);
      store.openGap(META.sessionKey, BASE + 20);
      store.closeGap(META.sessionKey, BASE + 30);
      expect(store.coverage(META.sessionKey).gaps).toEqual([{ from: BASE + 10, to: BASE + 30 }]);
      expect(store.coverage(META.sessionKey).capturedFrom).toBe(BASE);
    });

    it('keeps a row visible from when it was first seen when a reconnect sends it again', () => {
      const capture = new LiveCapture(store, META, BASE);
      const message = { topic: 'RaceControlMessages', data: { Messages: [{ Utc: utc(0), Category: 'Flag', Message: 'GREEN' }] } };
      capture.append([{ ...message, receivedAt: BASE + 1_000 }]);
      capture.append([{ ...message, snapshot: true, receivedAt: BASE + 9_000 }]);
      expect(sql('SELECT visible_from FROM race_control', BASE + 9_000)).toEqual([{ visible_from: BASE + 1_000 }]);
    });

    it("ignores another session's details", () => {
      const capture = new LiveCapture(store, META, BASE);
      capture.append([{ topic: 'SessionInfo', data: { Key: 999, Type: 'Practice' }, receivedAt: BASE }]);
      capture.append([{ topic: 'ChampionshipPrediction', data: { Drivers: { '1': { PredictedPoints: 5 } } }, receivedAt: BASE }]);
      expect(sql('SELECT * FROM championship_drivers', BASE)).toHaveLength(1);
    });
  });

  describe('consumers can only read, and only the views', () => {
    beforeEach(() => ingest());
    const denied = (query: string) => expect(() => sql(query, at(600_000))).toThrow();

    it('refuses the tables behind the views, which hold the whole session', () => {
      denied('SELECT * FROM t_laps');
      denied('SELECT * FROM main.t_position');
      denied('SELECT * FROM t_session_result');
      denied('SELECT * FROM t_live_messages');
      denied('SELECT * FROM t_ingest');
      denied('SELECT * FROM sqlite_master');
      denied('SELECT * FROM (SELECT * FROM t_laps)');
    });

    it('refuses every kind of write', () => {
      denied('DELETE FROM laps');
      denied("UPDATE laps SET lap_duration = 1");
      denied('INSERT INTO laps (lap_number) VALUES (1)');
      denied('DELETE FROM t_laps');
      denied('DROP TABLE t_laps');
      denied('DROP VIEW laps');
      denied('CREATE TABLE x (y)');
      denied('CREATE TEMP TABLE x (y)');
      denied('CREATE TEMP VIEW x AS SELECT * FROM t_laps');
    });

    it('refuses anything that could reach outside', () => {
      denied("ATTACH '/tmp/x.sqlite' AS x");
      denied('PRAGMA journal_mode');
      denied("SELECT load_extension('x')");
    });

    it("can't change what the playhead allows from inside a query", () => {
      expect(sql('SELECT COUNT(*) AS n FROM position WHERE visible_from > 0', at(49_999))[0].n).toBe(0);
    });

    it('takes parameters and ordinary SQL', () => {
      expect(sql('WITH p AS (SELECT driver_number, MAX(date) AS d FROM position GROUP BY 1) SELECT driver_number FROM p WHERE driver_number = ?', at(600_000), [1])).toEqual([{ driver_number: 1 }]);
      expect(store.sql(META.sessionKey, at(0), 'SELECT driver_number, position FROM position').columns).toEqual(['driver_number', 'position']);
    });

    it('hides internal keys', () => {
      expect(store.sql(META.sessionKey, at(600_000), 'SELECT * FROM race_control').columns).not.toContain('row_key');
    });
  });

  it('rebuilds tables from an older schema, so new columns exist', () => {
    store.close();
    const file = path.join(dir, 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE t_laps (session_key INTEGER NOT NULL, driver_number INTEGER NOT NULL, lap_number INTEGER NOT NULL, visible_from INTEGER NOT NULL); PRAGMA user_version = 2');
    old.close();
    store = new TimingStore(file);
    ingest();
    expect(sql('SELECT is_out FROM laps LIMIT 1', at(600_000))).toEqual([{ is_out: 0 }]);
  });

  it('keeps the calendar across restarts', () => {
    store.saveSchedule({ meetings: [], sessions: [], refreshedAt: 5 });
    store.close();
    store = new TimingStore(path.join(dir, 'test.sqlite'));
    expect(store.schedule()).toEqual({ meetings: [], sessions: [], refreshedAt: 5 });
  });

  it('keeps each circuit under its own key', () => {
    const circuit = { circuitKey: 9, name: 'Austin', refreshedAt: 5, outline: { x: [0, 1], y: [0, 1] }, corners: [], rotation: 0, pitLoss: { normal: 20.81, safetyCar: null, virtualSafetyCar: null } };
    store.saveCircuit(circuit);
    store.saveCircuit({ ...circuit, circuitKey: 10, name: 'Other' });
    store.close();
    store = new TimingStore(path.join(dir, 'test.sqlite'));
    expect(store.circuit(9)).toEqual(circuit);
    expect(store.circuit(10)?.name).toBe('Other');
    expect(store.circuit(11)).toBeNull();
    expect(store.schedule()).toBeNull();
  });
});
