// Checks our ingestion against OpenF1, on sessions whose archives the app has already cached. Reports
// counts and match rates only, so it says nothing about how a race went.
// Usage: npm run build:electron && node scripts/openf1-compare.mjs [sessionKey ...]
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MAIN_PROFILE } from './platform.mjs';

const require = createRequire(import.meta.url);
const { TimingStore } = require('../dist-electron/electron/timingdb/store.js');
const { ingestTiming } = require('../dist-electron/electron/timingdb/ingest.js');
const { TIMING_FEEDS } = require('../dist-electron/electron/timingdb/processors.js');

const CACHE = path.join(MAIN_PROFILE, 'livetiming-cache');
const API = 'https://api.openf1.org/v1';
const STATIC = 'https://livetiming.formula1.com/static';
const ALL_VISIBLE = Number.MAX_SAFE_INTEGER;

const cached = (url) => {
  const file = path.join(CACHE, `${createHash('sha1').update(url).digest('hex')}.gz`);
  return existsSync(file) ? zlib.gunzipSync(readFileSync(file)).toString('utf8') : null;
};

/** Each cached SessionInfo file names its session and where the rest of its files are. */
function cachedSessions() {
  const out = [];
  for (const name of readdirSync(CACHE)) {
    let text;
    try {
      text = zlib.gunzipSync(readFileSync(path.join(CACHE, name))).toString('utf8');
    } catch {
      continue;
    }
    const head = text.slice(0, 2000);
    if (!head.includes('"ArchiveStatus"')) continue;
    const line = text.replace(/^﻿/, '').split(/\r?\n/)[0];
    try {
      const info = JSON.parse(line.slice(12));
      const year = Number(String(info.StartDate).slice(0, 4));
      if (year >= 2023 && info.Path && info.Key && info.Meeting?.Key) out.push({ key: info.Key, meeting: info.Meeting.Key, type: info.Type, year, path: info.Path, end: info.EndDate, offset: info.GmtOffset });
    } catch {
      // Not the file we're after.
    }
  }
  return out;
}

async function api(endpoint, sessionKey) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}/${endpoint}?session_key=${sessionKey}`, { headers: { 'User-Agent': 'omfv-compare' } });
    await new Promise((r) => setTimeout(r, 700));
    if (res.status === 404) return [];
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${endpoint}: rate limited`);
}

const ms = (iso) => (iso ? Date.parse(iso) : null);

/** Lines up rows by key and counts, per field, how many agree. Numbers within `tolerance` count as equal. */
function compare(ours, theirs, keyOf, fields, tolerance = {}) {
  const mine = new Map(ours.map((row) => [keyOf(row), row]));
  const reference = new Map(theirs.map((row) => [keyOf(row), row]));
  const both = [...reference.keys()].filter((key) => mine.has(key));
  const report = { ours: mine.size, openf1: reference.size, both: both.length, mismatches: {} };
  for (const [field, normalize] of Object.entries(fields)) {
    let wrong = 0;
    for (const key of both) {
      const a = mine.get(key)[field];
      const b = (normalize ?? ((v) => v))(reference.get(key)[field]);
      const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= (tolerance[field] ?? 0.0005) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      if (!same) wrong += 1;
    }
    if (wrong) report.mismatches[field] = wrong;
  }
  return report;
}

const only = process.argv.slice(2).map(Number);
let sessions = cachedSessions().filter((s) => !only.length || only.includes(s.key));
sessions = sessions.filter((s) => cached(`${STATIC}/${s.path}TimingData.jsonStream`) && cached(`${STATIC}/${s.path}TimingAppData.jsonStream`));
sessions.sort((a, b) => b.year - a.year);
if (!only.length) sessions = sessions.filter((s, i) => i % 3 === 0).slice(0, 6);
console.log(`Comparing ${sessions.length} cached sessions with OpenF1\n`);

for (const session of sessions) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'omfv-compare-'));
  const store = new TimingStore(path.join(dir, 'c.sqlite'));
  try {
    const files = {};
    const missing = [];
    for (const feed of TIMING_FEEDS) {
      const text = cached(`${STATIC}/${session.path}${feed}.jsonStream`);
      if (text) files[feed] = text;
      else missing.push(feed);
    }
    const started = performance.now();
    ingestTiming(store, { meetingKey: session.meeting, sessionKey: session.key, isRace: session.type === 'Race' }, { files, failed: [] }, null, Date.now());
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    const coverage = store.coverage(session.key);
    const sql = (q) => store.sql(session.key, ALL_VISIBLE, q).rows;
    console.log(`${session.year} ${session.type} (${session.key}): ingested in ${seconds}s, timing ${coverage.datasets.timing.state}, not cached: ${missing.join(', ') || 'none'}`);

    const laps = await api('laps', session.key);
    const report = (name, r) => console.log(`  ${name.padEnd(14)} ours ${String(r.ours).padStart(6)}  openf1 ${String(r.openf1).padStart(6)}  in both ${String(r.both).padStart(6)}  mismatches ${JSON.stringify(r.mismatches)}`);
    report('laps', compare(sql('SELECT * FROM laps'), laps, (r) => `${r.driver_number}:${r.lap_number}`, {
      lap_duration: null,
      duration_sector_1: null,
      duration_sector_2: null,
      duration_sector_3: null,
      st_speed: null,
      i1_speed: null,
      i2_speed: null,
      date_start: ms,
    }, { date_start: 1000 }));

    const stints = await api('stints', session.key);
    report('stints', compare(sql('SELECT * FROM stints'), stints, (r) => `${r.driver_number}:${r.stint_number}`, { lap_start: null, lap_end: null, compound: null, tyre_age_at_start: null }));

    const pit = await api('pit', session.key);
    report('pit', compare(sql('SELECT * FROM pit'), pit, (r) => `${r.driver_number}:${r.lap_number}`, { lane_duration: null, stop_duration: null, pit_duration: null }));

    const position = await api('position', session.key);
    const positions = sql('SELECT driver_number, position, date FROM position ORDER BY date');
    // Paired by driver and order, since a car takes the same position many times.
    const sequence = (rows) => {
      const out = new Map();
      for (const r of rows) out.set(r.driver_number, [...(out.get(r.driver_number) ?? []), r]);
      return out;
    };
    const mine = sequence(positions);
    const theirs = sequence([...position].sort((a, b) => ms(a.date) - ms(b.date)));
    const deltas = [];
    let driversSame = 0;
    for (const [driver, rows] of theirs) {
      const own = mine.get(driver) ?? [];
      if (own.length === rows.length && own.every((r, i) => r.position === rows[i].position)) driversSame += 1;
      for (let i = 0; i < Math.min(own.length, rows.length); i++) if (own[i].position === rows[i].position) deltas.push(ms(rows[i].date) - own[i].date);
    }
    deltas.sort((a, b) => a - b);
    console.log(`  position       ours ${String(positions.length).padStart(6)}  openf1 ${String(position.length).padStart(6)}  drivers with identical sequence ${driversSame}/${theirs.size}`);
    if (deltas.length) console.log(`  clock offset   openf1 minus ours: median ${deltas[deltas.length >> 1]}ms, 5th ${deltas[Math.floor(deltas.length * 0.05)]}ms, 95th ${deltas[Math.floor(deltas.length * 0.95)]}ms`);

    const race = await api('race_control', session.key);
    report('race_control', compare(sql('SELECT * FROM race_control'), race, (r) => `${typeof r.date === 'string' ? ms(r.date) : r.date}:${r.category}:${r.message}`, { flag: null, scope: null, sector: null, lap_number: null, driver_number: null, qualifying_phase: null }));

    const weather = await api('weather', session.key);
    console.log(`  weather        ours ${String(sql('SELECT COUNT(*) AS n FROM weather')[0].n).padStart(6)}  openf1 ${String(weather.length).padStart(6)}`);

    const overtakes = await api('overtakes', session.key);
    console.log(`  overtakes      ours ${String(sql('SELECT COUNT(*) AS n FROM overtakes')[0].n).padStart(6)}  openf1 ${String(overtakes.length).padStart(6)}`);

    const drivers = await api('drivers', session.key);
    report('drivers', compare(sql('SELECT * FROM drivers'), drivers, (r) => r.driver_number, { name_acronym: null, team_name: null, team_colour: null, full_name: null }));

    const champ = await api('championship_drivers', session.key);
    report('championship', compare(sql('SELECT * FROM championship_drivers'), champ, (r) => r.driver_number, { position_start: null, position_current: null, points_start: null, points_current: null }));
    console.log();
  } catch (e) {
    console.log(`  failed: ${e.message}\n`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
