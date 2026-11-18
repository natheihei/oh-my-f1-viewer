/**
 * Turns feed messages into table rows. Adapted from OpenF1's collections
 * (https://github.com/br-g/openf1, CC BY-NC-SA 4.0), which is also the reference for checking the output.
 *
 * Differences from OpenF1:
 * - Times are UTC milliseconds.
 * - A message can be a live snapshot of a session already under way. It reveals the current state
 *   but not what led to it, so it starts the laps from where the session is and invents nothing.
 *
 * Pure: no database or network. Each processor keeps the state it needs to build rows across messages.
 */
import { parseUtc } from '../../shared/feedTime';
import type { RowTable } from './schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Message {
  topic: string;
  content: any;
  /** When the feed says this happened. */
  time: number;
  /** A live `Subscribe` reply: the current state, not a change. */
  snapshot?: boolean;
}

export interface Emission {
  table: RowTable;
  row: Record<string, unknown>;
}

const TEN_SECONDS = 10_000;

function toInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value);
  return null;
}

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses "1:23.456" or "1:02:03.4" into seconds. */
export function durationSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split(':').map(Number);
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return null;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000) / 1000;
}

/** An object keyed by number, or a list, as a list. The feeds send both for the same thing. */
const listOf = (value: unknown): any[] => (Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []);

/** `Lines` is keyed by driver number, but older streams can send a list that carries no numbers. */
function driverEntries(lines: unknown): Array<[number, Record<string, any>]> {
  if (!isObject(lines)) return [];
  const out: Array<[number, Record<string, any>]> = [];
  for (const [key, data] of Object.entries(lines)) {
    const driver = toInt(key);
    if (driver !== null && isObject(data)) out.push([driver, data]);
  }
  return out;
}

type Key = { meeting_key: number; session_key: number };

interface Processor {
  topics: string[];
  process(message: Message): Iterable<Emission>;
}

// --- One row per message: nothing to remember ---

class PositionProcessor implements Processor {
  topics = ['TimingData'];
  constructor(private key: Key) {}
  *process({ content, time }: Message): Iterable<Emission> {
    for (const [driver, data] of driverEntries(content?.Lines)) {
      if (data.Line === undefined) continue;
      yield { table: 'position', row: { ...this.key, driver_number: driver, date: time, position: data.Line } };
    }
  }
}

/**
 * When each car goes into the pit lane and comes out, from `TimingData`'s `InPit`: `true` as it enters,
 * `false` as it leaves. F1 repeats the flag, so a row is only a change. A car's first row is where it
 * stood when the feed first said, such as in the garage before practice.
 */
class PitLaneProcessor implements Processor {
  topics = ['TimingData'];
  private inPit = new Map<number, boolean>();
  constructor(private key: Key) {}
  *process({ content, time }: Message): Iterable<Emission> {
    for (const [driver, data] of driverEntries(content?.Lines)) {
      if (typeof data.InPit !== 'boolean' || this.inPit.get(driver) === data.InPit) continue;
      this.inPit.set(driver, data.InPit);
      yield { table: 'pit_lane', row: { ...this.key, driver_number: driver, date: time, in_pit: data.InPit } };
    }
  }
}

class WeatherProcessor implements Processor {
  topics = ['WeatherData'];
  constructor(private key: Key) {}
  *process({ content, time }: Message): Iterable<Emission> {
    const air = toFloat(content?.AirTemp);
    if (air === null) return;
    yield {
      table: 'weather',
      row: {
        ...this.key,
        date: time,
        air_temperature: air,
        humidity: toFloat(content.Humidity),
        pressure: toFloat(content.Pressure),
        rainfall: toInt(content.Rainfall),
        track_temperature: toFloat(content.TrackTemp),
        wind_direction: toInt(content.WindDirection),
        wind_speed: toFloat(content.WindSpeed),
      },
    };
  }
}

/** Keeps F1's own word for the status, such as `SCDeployed`. OpenF1 has no such table. */
class TrackStatusProcessor implements Processor {
  topics = ['TrackStatus'];
  constructor(private key: Key) {}
  *process({ content, time }: Message): Iterable<Emission> {
    const status = typeof content?.Message === 'string' && content.Message ? content.Message : null;
    if (status === null) return;
    yield { table: 'track_status', row: { ...this.key, date: time, status } };
  }
}

/** The first message carries the scheduled distance, later ones only the lap. */
class LapCountProcessor implements Processor {
  topics = ['LapCount'];
  private current: number | null = null;
  private total: number | null = null;
  constructor(private key: Key) {}
  *process({ content }: Message): Iterable<Emission> {
    const current = toInt(content?.CurrentLap);
    const total = toInt(content?.TotalLaps);
    if (current === null && total === null) return;
    if (current !== null) this.current = current;
    if (total !== null) this.total = total;
    yield { table: 'lap_count', row: { ...this.key, current_lap: this.current, total_laps: this.total } };
  }
}

class CarDataProcessor implements Processor {
  topics = ['CarData.z'];
  constructor(private key: Key) {}
  *process({ content }: Message): Iterable<Emission> {
    for (const entry of listOf(content?.Entries)) {
      const date = parseUtc(entry?.Utc);
      if (date === null || !isObject(entry.Cars)) continue;
      for (const [driver, data] of driverEntries(entry.Cars)) {
        const c = data.Channels;
        if (!isObject(c)) continue;
        yield {
          table: 'car_data',
          row: { ...this.key, driver_number: driver, date, rpm: c['0'], speed: c['2'], n_gear: c['3'], throttle: c['4'], brake: c['5'], drs: c['45'] },
        };
      }
    }
  }
}

class LocationProcessor implements Processor {
  topics = ['Position.z'];
  constructor(private key: Key) {}
  *process({ content }: Message): Iterable<Emission> {
    for (const entry of listOf(content?.Position)) {
      const date = parseUtc(entry?.Timestamp);
      if (date === null) continue;
      for (const [driver, data] of driverEntries(entry.Entries)) {
        yield { table: 'location', row: { ...this.key, driver_number: driver, date, x: data.X, y: data.Y, z: data.Z } };
      }
    }
  }
}

class OvertakesProcessor implements Processor {
  topics = ['DriverRaceInfo'];
  constructor(private key: Key) {}
  *process({ content, time, snapshot }: Message): Iterable<Emission> {
    // A snapshot shows the last state of each car, not something happening now.
    if (snapshot || !isObject(content)) return;
    const entries = driverEntries(content);
    const overtaking = entries.find(([, data]) => data.OvertakeState === 2)?.[0];
    if (overtaking === undefined) return;
    const overtaken = entries
      .filter(([, data]) => data.OvertakeState !== 2 && data.Position !== undefined && data.Position !== null)
      .map(([driver, data]) => [toInt(data.Position), driver] as const)
      .filter((pair): pair is readonly [number, number] => pair[0] !== null)
      .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    for (const [position, driver] of overtaken) {
      yield {
        table: 'overtakes',
        row: {
          ...this.key,
          overtaking_driver_number: overtaking,
          overtaken_driver_number: driver,
          date: time,
          // The position is the one the overtaken car dropped to.
          position: position - 1,
        },
      };
    }
  }
}

/** "+6.924", "+1:09.473" and "LAP 3" as seconds; "+1 LAP" stays as text. */
function parseGap(gap: unknown): number | string | null {
  if (gap === null || gap === undefined || gap === '') return null;
  const text = String(gap);
  if (text.toUpperCase().startsWith('LAP')) return 0;
  if (!text.startsWith('+')) return typeof gap === 'number' ? gap : text;
  if (text.includes('LAP')) return text;
  const seconds = durationSeconds(text.slice(1));
  return seconds ?? text;
}

class IntervalsProcessor implements Processor {
  topics = ['DriverRaceInfo'];
  private lastGap = new Map<number, number | string>();
  constructor(private key: Key) {}
  *process({ content, time }: Message): Iterable<Emission> {
    for (const [driver, data] of driverEntries(content)) {
      let gap = parseGap(data.Gap);
      const interval = parseGap(data.Interval);
      if (gap === null && interval === null) continue;
      // The gap to the leader stops being sent once a car is lapped.
      if (gap === null && String(this.lastGap.get(driver) ?? '').startsWith('+')) gap = this.lastGap.get(driver) ?? null;
      if (gap !== null) this.lastGap.set(driver, gap);
      yield { table: 'intervals', row: { ...this.key, driver_number: driver, gap_to_leader: gap, interval, date: time } };
    }
  }
}

class RaceControlProcessor implements Processor {
  topics = ['RaceControlMessages', 'SessionData'];
  private raceLap: number | null = null;
  private qualifyingPhase: number | null = null;
  constructor(private key: Key) {}

  *process({ topic, content }: Message): Iterable<Emission> {
    if (topic === 'RaceControlMessages') {
      for (const data of listOf(content?.Messages)) {
        if (!isObject(data)) continue;
        const hasPhase = ['Flag', 'CarEvent', 'SafetyCar'].includes(data.Category);
        yield this.row({
          date: parseUtc(data.Utc),
          driver_number: toInt(data.RacingNumber),
          lap_number: data.Lap ?? null,
          category: data.Category ?? null,
          flag: data.Flag ?? null,
          scope: data.Scope ?? null,
          sector: data.Sector ?? null,
          qualifying_phase: hasPhase ? this.qualifyingPhase : null,
          message: data.Message ?? null,
        });
      }
      return;
    }
    for (const item of listOf(content?.StatusSeries)) {
      const status = item?.SessionStatus;
      if (typeof status !== 'string' || ['Inactive', 'Finalised', 'Ends'].includes(status)) continue;
      yield this.row({
        date: parseUtc(item.Utc),
        driver_number: null,
        lap_number: this.raceLap,
        category: 'SessionStatus',
        flag: null,
        scope: null,
        sector: null,
        qualifying_phase: this.qualifyingPhase,
        message: `SESSION ${status.toUpperCase()}`,
      });
    }
    for (const item of listOf(content?.Series)) {
      if (item?.QualifyingPart !== undefined && item.QualifyingPart !== null) this.qualifyingPhase = item.QualifyingPart;
      if (item?.Lap !== undefined && item.Lap !== null) this.raceLap = item.Lap;
    }
  }

  private row(fields: Record<string, unknown>): Emission {
    const { date, driver_number, lap_number, category, flag, scope, sector } = fields;
    return {
      table: 'race_control',
      row: { ...this.key, ...fields, row_key: JSON.stringify([date, driver_number, lap_number, category, flag, scope, sector]) },
    };
  }
}

// --- Rows that change as the session goes on: each change is a new version ---

/**
 * `PitStop` is the most detailed source. `PitStopSeries` and then `PitLaneTimeCollection` only fill in
 * stops it doesn't have, since older sessions lack it.
 */
class PitProcessor implements Processor {
  topics = ['PitStop', 'PitStopSeries', 'PitLaneTimeCollection'];
  private seen = new Set<string>();
  private lastPitStopLap: number | null = null;
  private lastSeriesLap: number | null = null;
  constructor(private key: Key) {}

  private pit(driver: number, lap: number, date: number | null, lane: number | null, stop: number | null): Emission {
    return {
      table: 'pit',
      row: { ...this.key, driver_number: driver, lap_number: lap, date, pit_duration: lane, lane_duration: lane, stop_duration: stop },
    };
  }

  *process({ topic, content, time }: Message): Iterable<Emission> {
    if (topic === 'PitStop') {
      const driver = toInt(content?.RacingNumber);
      if (driver === null) return;
      const lap = toInt(content.Lap) ?? this.lastPitStopLap;
      if (lap === null) return;
      this.lastPitStopLap = lap;
      this.seen.add(`${driver}:${lap}`);
      yield this.pit(driver, lap, time, toFloat(content.PitLaneTime), toFloat(content.PitStopTime));
    } else if (topic === 'PitStopSeries') {
      for (const [driver, data] of isObject(content?.PitTimes) ? Object.entries(content.PitTimes) : []) {
        const number = toInt(driver);
        if (number === null) continue;
        for (const info of listOf(data)) {
          if (!isObject(info?.PitStop)) continue;
          const lap = toInt(info.PitStop.Lap) ?? this.lastSeriesLap;
          if (lap === null) continue;
          this.lastSeriesLap = lap;
          const key = `${number}:${lap}`;
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          yield this.pit(number, lap, parseUtc(info.Timestamp), toFloat(info.PitStop.PitLaneTime), toFloat(info.PitStop.PitStopTime));
        }
      }
    } else {
      for (const [driver, data] of driverEntries(content?.PitTimes)) {
        const lap = toInt(data.Lap);
        if (lap === null) continue;
        const key = `${driver}:${lap}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        yield this.pit(driver, lap, time, toFloat(data.Duration), null);
      }
    }
  }
}

const DRIVER_FIELDS: Record<string, string> = {
  BroadcastName: 'broadcast_name',
  CountryCode: 'country_code',
  FirstName: 'first_name',
  FullName: 'full_name',
  HeadshotUrl: 'headshot_url',
  LastName: 'last_name',
  TeamColour: 'team_colour',
  TeamName: 'team_name',
  Tla: 'name_acronym',
};

class DriversProcessor implements Processor {
  topics = ['DriverList'];
  private drivers = new Map<number, Record<string, unknown>>();
  constructor(private key: Key) {}
  *process({ content }: Message): Iterable<Emission> {
    for (const [number, data] of driverEntries(content)) {
      const known = this.drivers.get(number);
      if (!known && data.FullName === undefined) continue;
      const driver = known ?? { ...this.key, driver_number: number };
      this.drivers.set(number, driver);
      let changed = !known;
      for (const [from, to] of Object.entries(DRIVER_FIELDS)) {
        if (data[from] === undefined || data[from] === null || driver[to] === data[from]) continue;
        driver[to] = data[from];
        changed = true;
      }
      if (changed) yield { table: 'drivers', row: { ...driver } };
    }
  }
}

/** Dropped outside races: other sessions have been seen carrying wrong predictions. */
class ChampionshipProcessor implements Processor {
  topics = ['ChampionshipPrediction', 'SessionInfo'];
  private isRace: boolean | null;
  private drivers = new Map<number, Record<string, unknown>>();
  private teams = new Map<string, Record<string, unknown>>();
  constructor(private key: Key, isRace: boolean | null) {
    this.isRace = isRace;
  }

  private apply(target: Record<string, unknown>, data: Record<string, any>): void {
    if (data.CurrentPosition > 0) target.position_start = data.CurrentPosition;
    if (data.PredictedPosition > 0) target.position_current = data.PredictedPosition;
    if (data.CurrentPoints !== undefined) target.points_start = data.CurrentPoints;
    if (data.PredictedPoints !== undefined) target.points_current = data.PredictedPoints;
  }

  *process({ topic, content }: Message): Iterable<Emission> {
    if (topic === 'SessionInfo') {
      if (typeof content?.Type === 'string') this.isRace = content.Type.toLowerCase() === 'race';
      return;
    }
    if (this.isRace === false) return;
    for (const [number, data] of driverEntries(content?.Drivers)) {
      const row = this.drivers.get(number) ?? { ...this.key, driver_number: number };
      this.drivers.set(number, row);
      this.apply(row, data);
      yield { table: 'championship_drivers', row: { ...row } };
    }
    for (const [teamKey, data] of isObject(content?.Teams) ? Object.entries<any>(content.Teams) : []) {
      if (!isObject(data)) continue;
      const row = this.teams.get(teamKey) ?? { ...this.key, team_key: teamKey, team_name: null };
      this.teams.set(teamKey, row);
      if (data.TeamName) row.team_name = data.TeamName;
      this.apply(row, data);
      yield { table: 'championship_teams', row: { ...row } };
    }
  }
}

interface Stint {
  driver_number: number;
  stint_number: number;
  lap_start: number;
  lap_end: number;
  compound: string | null;
  tyre_age_at_start: number | null;
  /** When this car's last lap began, to catch lap data that arrives ahead of the stint's. */
  lastLapStart: number | null;
}

class StintsProcessor implements Processor {
  topics = ['TimingAppData', 'TimingData'];
  private stints = new Map<number, Map<number, Stint>>();
  private updated = new Set<Stint>();
  constructor(private key: Key) {}

  private of(driver: number): Map<number, Stint> {
    let map = this.stints.get(driver);
    if (!map) this.stints.set(driver, (map = new Map()));
    return map;
  }

  private last(driver: number): Stint | null {
    const numbers = [...this.of(driver).keys()];
    return numbers.length ? this.of(driver).get(Math.max(...numbers))! : null;
  }

  private set<K extends keyof Stint>(stint: Stint, property: K, value: Stint[K]): void {
    if (stint[property] === value) return;
    stint[property] = value;
    this.updated.add(stint);
  }

  private add(driver: number, stintNumber: number, time: number, snapshot = false): void {
    const last = this.last(driver);
    // Lap data sometimes arrives before the stint's own: that lap belongs to the new stint. A snapshot
    // lists stints that ended long ago all at once, so there it means nothing.
    if (!snapshot && last?.lastLapStart != null && time - last.lastLapStart < TEN_SECONDS) this.set(last, 'lap_end', last.lap_end - 1);
    const lapStart = last ? last.lap_end + 1 : 1;
    this.of(driver).set(stintNumber, {
      driver_number: driver,
      stint_number: stintNumber,
      lap_start: lapStart,
      lap_end: lapStart,
      compound: null,
      tyre_age_at_start: null,
      lastLapStart: null,
    });
  }

  *process({ topic, content, time, snapshot }: Message): Iterable<Emission> {
    for (const [driver, data] of driverEntries(content?.Lines)) {
      if (topic === 'TimingAppData') this.fromApp(driver, data, time, snapshot === true);
      else this.fromTiming(driver, data, time);
    }
    for (const stint of this.updated) {
      const { lastLapStart: _unused, ...fields } = stint;
      yield { table: 'stints', row: { ...this.key, ...fields } };
    }
    this.updated.clear();
  }

  private fromApp(driver: number, data: Record<string, any>, time: number, snapshot: boolean): void {
    const raw = data.Stints;
    if (!raw) return;
    const entries: Array<[number, unknown]> = Array.isArray(raw)
      ? raw.map((value, index) => [index, value])
      : isObject(raw)
        ? Object.entries(raw)
            .map(([key, value]): [number, unknown] => [Number(key), value])
            .filter(([key]) => Number.isInteger(key))
            .sort((a, b) => a[0] - b[0])
        : [];
    for (const [index, item] of entries) {
      const number = index + 1;
      if (!this.of(driver).has(number)) this.add(driver, number, time, snapshot);
      const stint = this.of(driver).get(number)!;
      if (!isObject(item)) continue;
      if ('Compound' in item) this.set(stint, 'compound', item.Compound);
      if (item.StartLaps !== undefined && item.StartLaps !== null) {
        // F1 often corrects the tyre's age just after the stint first appears, so always take it.
        this.set(stint, 'tyre_age_at_start', item.StartLaps);
      } else if ('TotalLaps' in item && stint.tyre_age_at_start === null) {
        this.set(stint, 'tyre_age_at_start', item.TotalLaps);
      }
      // Joining mid-race: the laps a finished stint covered can only be read from the snapshot.
      if (snapshot && typeof item.TotalLaps === 'number' && typeof item.StartLaps === 'number') {
        this.set(stint, 'lap_end', stint.lap_start + Math.max(0, item.TotalLaps - item.StartLaps - 1));
      }
    }
  }

  private fromTiming(driver: number, data: Record<string, any>, time: number): void {
    if (this.of(driver).size === 0) this.add(driver, 1, time);
    if (!('NumberOfLaps' in data)) return;
    const stint = this.last(driver);
    if (!stint) return;
    if (data.NumberOfLaps !== null && data.NumberOfLaps !== undefined) this.set(stint, 'lap_end', data.NumberOfLaps);
    this.set(stint, 'lastLapStart', time);
  }
}

interface Lap {
  driver_number: number;
  lap_number: number;
  date_start: number | null;
  duration_sector_1: number | null;
  duration_sector_2: number | null;
  duration_sector_3: number | null;
  i1_speed: number | null;
  i2_speed: number | null;
  st_speed: number | null;
  is_pit_out_lap: boolean;
  lap_duration: number | null;
  segments_sector_1: Array<number | null> | null;
  segments_sector_2: Array<number | null> | null;
  segments_sector_3: Array<number | null> | null;
  /** The car retired during this lap. */
  is_out: boolean;
}

type SectorNumber = 1 | 2 | 3;

/**
 * A car is out from when `DriverRaceInfo` says `IsOut`, or `TimingData` says `Retired`: the second
 * only for archives without the first, since it's missing for some retirements. `Stopped` doesn't
 * count, as a car can restart. Neither has been seen to go back, so once out a car stays out.
 */
class LapsProcessor implements Processor {
  topics = ['SessionInfo', 'RaceControlMessages', 'TimingAppData', 'TimingData', 'SessionData', 'DriverRaceInfo'];
  private started = false;
  private out = new Set<number>();
  private isRace: boolean | null;
  private chequeredFlag: number | null = null;
  private laps = new Map<number, Lap[]>();
  private updated = new Set<Lap>();
  constructor(private key: Key, isRace: boolean | null) {
    this.isRace = isRace;
  }

  private add(driver: number, lapNumber: number): Lap {
    const lap: Lap = {
      driver_number: driver,
      lap_number: lapNumber,
      date_start: null,
      duration_sector_1: null,
      duration_sector_2: null,
      duration_sector_3: null,
      i1_speed: null,
      i2_speed: null,
      st_speed: null,
      is_pit_out_lap: false,
      lap_duration: null,
      segments_sector_1: null,
      segments_sector_2: null,
      segments_sector_3: null,
      is_out: this.out.has(driver),
    };
    const laps = this.laps.get(driver) ?? [];
    laps.push(lap);
    this.laps.set(driver, laps);
    return lap;
  }

  /**
   * Which lap new data belongs to. Sector and lap times can arrive just after the next lap began, so
   * end-of-lap data within 10 seconds of a lap's start goes to the one before.
   */
  private current(driver: number, time: number | null, endOfLap: boolean): Lap | null {
    if (!this.laps.has(driver)) this.add(driver, 1);
    const laps = this.laps.get(driver)!;
    const lap = laps[laps.length - 1];
    if (endOfLap && lap.date_start !== null && time !== null && time - lap.date_start < TEN_SECONDS) {
      return laps.length < 2 ? null : laps[laps.length - 2];
    }
    return lap;
  }

  private update<K extends keyof Lap>(driver: number, property: K, value: Lap[K], endOfLap = false, time: number | null = null): void {
    const lap = this.current(driver, time, endOfLap);
    if (!lap) return;
    const same = Array.isArray(value) ? false : lap[property] === value;
    if (same) return;
    lap[property] = value;
    if (String(property).startsWith('duration_sector_') && !lap.lap_duration && lap.duration_sector_1 && lap.duration_sector_2 && lap.duration_sector_3) {
      lap.lap_duration = Math.round((lap.duration_sector_1 + lap.duration_sector_2 + lap.duration_sector_3) * 1000) / 1000;
    }
    // A race's laps that begin after the chequered flag are cars coming back to the pits.
    if (this.isRace && this.chequeredFlag !== null && lap.date_start !== null && this.chequeredFlag < lap.date_start) return;
    this.updated.add(lap);
  }

  private flush(): Emission[] {
    const out = [...this.updated].map((lap) => ({ table: 'laps' as const, row: { ...this.key, ...lap } }));
    this.updated.clear();
    return out;
  }

  *process(message: Message): Iterable<Emission> {
    const { topic, content, time, snapshot } = message;
    if (topic === 'SessionInfo') {
      if (typeof content?.Type === 'string') this.isRace = content.Type.toLowerCase() === 'race';
      return;
    }
    if (topic === 'SessionData') {
      if (this.isRace) {
        for (const item of listOf(content?.StatusSeries)) {
          const date = parseUtc(item?.Utc);
          if (date === null || item.SessionStatus !== 'Started') continue;
          for (const laps of this.laps.values()) {
            if (laps.length === 1 && laps[0].lap_number === 1) {
              laps[0].date_start = date;
              this.updated.add(laps[0]);
            }
          }
        }
      }
      return;
    }
    if (topic === 'RaceControlMessages') {
      for (const data of listOf(content?.Messages)) {
        if (String(data?.Message ?? '').toUpperCase() === 'CHEQUERED FLAG') this.chequeredFlag = time;
      }
      return;
    }
    if (topic === 'DriverRaceInfo') {
      for (const [driver, data] of driverEntries(content)) if (data.IsOut === true) this.markOut(driver, snapshot === true);
      yield* this.flush();
      return;
    }
    if (snapshot) {
      this.fromSnapshot(topic, content);
      yield* this.flush();
      return;
    }
    if (topic === 'TimingAppData') {
      if (driverEntries(content?.Lines).some(([, data]) => data.Stints)) this.started = true;
      return;
    }
    if (!this.started) return;
    for (const [driver, data] of driverEntries(content?.Lines)) this.fromTiming(driver, data, time);
    yield* this.flush();
  }

  /** A snapshot's lap counts tell us which lap each car is on. Its last-lap details are from before we joined. */
  private fromSnapshot(topic: string, content: any): void {
    if (topic === 'TimingAppData') {
      if (driverEntries(content?.Lines).some(([, data]) => data.Stints)) this.started = true;
      return;
    }
    if (topic !== 'TimingData') return;
    for (const [driver, data] of driverEntries(content?.Lines)) {
      if (data.Retired === true) this.markOut(driver, true);
      if (typeof data.NumberOfLaps !== 'number') continue;
      const lapNumber = data.NumberOfLaps + (this.isRace ? 1 : 0);
      const laps = this.laps.get(driver);
      if (!laps?.length || laps[laps.length - 1].lap_number < lapNumber) this.updated.add(this.add(driver, lapNumber));
    }
  }

  /**
   * Marks the lap the car is on. A snapshot can say a car is out before saying which lap it's on, so
   * then the mark waits for the lap to be made.
   */
  private markOut(driver: number, snapshot: boolean): void {
    if (this.out.has(driver)) return;
    this.out.add(driver);
    if (snapshot && !this.laps.has(driver)) return;
    this.update(driver, 'is_out', true);
  }

  private fromTiming(driver: number, data: Record<string, any>, time: number): void {
    const lapTime = durationSeconds(isObject(data.LastLapTime) ? data.LastLapTime.Value : undefined);
    if (lapTime !== null) this.update(driver, 'lap_duration', lapTime, true, time);

    if (isObject(data.Sectors)) {
      for (const [index, sector] of Object.entries<any>(data.Sectors)) {
        const number = toInt(index);
        if (number === null || !isObject(sector)) continue;
        const sectorNumber = (number + 1) as SectorNumber;
        const endOfLap = sectorNumber > 1;
        if ('Value' in sector) {
          const duration = toFloat(sector.Value);
          if (duration !== null) this.update(driver, `duration_sector_${sectorNumber}`, duration, endOfLap, time);
        }
        if (isObject(sector.Segments)) {
          for (const [segmentIndex, segment] of Object.entries<any>(sector.Segments)) {
            const segmentNumber = toInt(segmentIndex);
            if (segmentNumber === null || !isObject(segment)) continue;
            this.segment(driver, sectorNumber, segmentNumber, segment.Status ?? null, endOfLap, time);
          }
        }
      }
    }

    if (isObject(data.Speeds)) {
      for (const [label, speed] of Object.entries<any>(data.Speeds)) {
        if (label !== 'ST' && !label.startsWith('I')) continue;
        const value = toInt(speed?.Value);
        if (value !== null && ['ST', 'I1', 'I2'].includes(label)) this.update(driver, `${label.toLowerCase()}_speed` as 'st_speed', value);
      }
    }

    if (typeof data.NumberOfLaps === 'number') {
      // During a race, the first lap isn't counted until it's over.
      const lapNumber = data.NumberOfLaps + (this.isRace ? 1 : 0);
      let current = this.current(driver, time, false)!;
      if (lapNumber > current.lap_number) current = this.add(driver, lapNumber);
      if (current.date_start === null) {
        this.update(driver, 'date_start', time);
        if (this.isRace && current.lap_number === 2) this.inferFirstLap(driver, current);
      }
    }

    // F1 also sends `PitOut: false`, which marked every car's first lap until it was read as a value.
    if (data.PitOut === true) this.update(driver, 'is_pit_out_lap', true);
    if (data.Retired === true) this.markOut(driver, false);
  }

  /** Lap 1 has no lap time of its own. It runs from the start to the beginning of lap 2. */
  private inferFirstLap(driver: number, second: Lap): void {
    const first = this.laps.get(driver)?.[0];
    if (!first || first.lap_number !== 1) return;
    if (!first.lap_duration && first.date_start !== null && second.date_start !== null) {
      first.lap_duration = Math.round(second.date_start - first.date_start) / 1000;
    }
    if (first.lap_duration && !first.duration_sector_1 && first.duration_sector_2 && first.duration_sector_3) {
      first.duration_sector_1 = Math.round((first.lap_duration - first.duration_sector_2 - first.duration_sector_3) * 1000) / 1000;
    }
    this.updated.add(first);
  }

  private segment(driver: number, sector: SectorNumber, segment: number, status: number | null, endOfLap: boolean, time: number): void {
    const lap = this.current(driver, time, endOfLap);
    if (!lap) return;
    const property = `segments_sector_${sector}` as const;
    const statuses = [...(lap[property] ?? [])];
    while (segment >= statuses.length) statuses.push(null);
    statuses[segment] = status;
    this.update(driver, property, statuses, endOfLap, time);
  }
}

/** The topics each dataset is built from. ExtrapolatedClock only anchors the clock. */
export const TIMING_FEEDS = [
  'SessionInfo',
  'DriverList',
  'TimingData',
  'TimingAppData',
  'RaceControlMessages',
  'SessionData',
  'DriverRaceInfo',
  'PitStop',
  'PitStopSeries',
  'PitLaneTimeCollection',
  'WeatherData',
  'ChampionshipPrediction',
  'TrackStatus',
  'LapCount',
  'ExtrapolatedClock',
] as const;

export const TELEMETRY_FEEDS = ['CarData.z', 'Position.z'] as const;

export interface SessionMeta {
  meetingKey: number;
  sessionKey: number;
  /** Known before the feed says so when the catalog already has it. */
  isRace: boolean | null;
}

/** Routes messages to the processors that want them, and survives a malformed message. */
class Router {
  private byTopic = new Map<string, Processor[]>();

  constructor(processors: Processor[], private sessionKey: number) {
    for (const processor of processors) {
      for (const topic of processor.topics) this.byTopic.set(topic, [...(this.byTopic.get(topic) ?? []), processor]);
    }
  }

  process(message: Message): Emission[] {
    // F1 has been seen sending another session's details, which must not change this one's state.
    if (message.topic === 'SessionInfo' && message.content?.Key != null && Number(message.content.Key) !== this.sessionKey) return [];
    const out: Emission[] = [];
    for (const processor of this.byTopic.get(message.topic) ?? []) {
      try {
        for (const emission of processor.process(message)) out.push(emission);
      } catch (e) {
        console.warn(`[timingdb] ${processor.constructor.name} skipped a ${message.topic} message:`, (e as Error).message);
      }
    }
    return out;
  }
}

export function timingRouter({ meetingKey, sessionKey, isRace }: SessionMeta): Router {
  const key = { meeting_key: meetingKey, session_key: sessionKey };
  return new Router(
    [
      new PositionProcessor(key),
      new PitLaneProcessor(key),
      new WeatherProcessor(key),
      new TrackStatusProcessor(key),
      new LapCountProcessor(key),
      new OvertakesProcessor(key),
      new IntervalsProcessor(key),
      new RaceControlProcessor(key),
      new PitProcessor(key),
      new DriversProcessor(key),
      new ChampionshipProcessor(key, isRace),
      new StintsProcessor(key),
      new LapsProcessor(key, isRace),
    ],
    sessionKey,
  );
}

export function telemetryRouter({ meetingKey, sessionKey }: SessionMeta): Router {
  const key = { meeting_key: meetingKey, session_key: sessionKey };
  return new Router([new CarDataProcessor(key), new LocationProcessor(key)], sessionKey);
}
