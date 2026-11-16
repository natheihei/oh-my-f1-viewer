// Checks the browser build end to end in a Chrome of its own, over a real replay race, muted: sign-in,
// DRM video, the session database (timing and telemetry), several streams and charts, a mod's life, build
// mode's snapshot, the build agent's picture, and that it all survives a reload. Saves screenshots.
// With --agent it also runs the real agent, viewing and building, on the desktop app's agent login.
//
// Needs `npm run build:web`, Google Chrome, and the desktop app's F1 TV sign-in in ~/.config/f1a (Linux
// keyring). Prints race data: this is dev output.
// Usage: node scripts/web-check.mjs <screenshot-dir> [--agent]
//   F1A_YEAR and F1A_EVENT pick the race (2025, mexic).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { borrowAgentLogin, paletteText, returnAgentLogin, signInFromMainProfile, startWebApp, typeInPalette } from './web.mjs';

const outDir = process.argv[2];
if (!outDir || outDir.startsWith('--')) throw new Error('Usage: node scripts/web-check.mjs <screenshot-dir> [--agent]');
const withAgent = process.argv.includes('--agent');
const YEAR = Number(process.env.F1A_YEAR ?? 2025);
const EVENT = process.env.F1A_EVENT ?? 'mexic';
const MOD = 'lap_form';
const source = readFileSync(path.resolve('examples/mods/lap_form/main.tsx'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await startWebApp(outDir, { name: 'web-check' });
let page = await app.open();
const shoot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`), timeout: 20_000 }).catch((e) => console.log(`  (no screenshot ${name}: ${e.message.split('\n')[0]})`));
const done = async (code) => {
  if (withAgent) console.log('agent login:', await returnAgentLogin(page).catch((e) => e.message));
  await app.stop();
  process.exit(code);
};
process.on('uncaughtException', async (e) => {
  console.log('FAIL', e.message);
  await done(1);
});
const waitFor = async (what, read, ok, ms) => {
  const deadline = Date.now() + ms;
  let value;
  while (Date.now() < deadline) {
    value = await page.evaluate(read).catch(() => undefined);
    if (ok(value)) return value;
    await sleep(1000);
  }
  console.log(`  (timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 200)})`);
  return value;
};
const mods = () => page.evaluate(() => window.f1a.mods.list());
const writeMod = (text) => page.evaluate(({ MOD, text }) => {
  const { fs } = window.__f1aWeb;
  fs.mkdirSync(`/f1a/mods/${MOD}`, { recursive: true });
  fs.writeFileSync(`/f1a/mods/${MOD}/main.tsx`, text);
}, { MOD, text });

console.log('sign-in');
check('F1 TV signs in from cookies in the browser', await signInFromMainProfile(app.context, page));
if (failures) await done(1);

console.log('a replay race');
const opened = await page.evaluate(
  async ({ YEAR, EVENT }) => {
    const { host } = window;
    host.audio.setVolume({ volume: 0 });
    const re = new RegExp(EVENT, 'i');
    const event = (await host.catalog.events({ year: YEAR })).find((e) => re.test(e.name) || re.test(e.shortName));
    if (!event) return null;
    const sessions = await host.catalog.sessions({ pageId: event.pageId, year: YEAR });
    const race = sessions.find((s) => s.type === 'race' && s.series === 'FORMULA 1') ?? sessions.find((s) => s.type === 'race');
    if (!race) return null;
    await host.session.open({ contentId: race.contentId, title: race.title });
    return race.title;
  },
  { YEAR, EVENT },
);
check('the catalog finds the race', !!opened, opened ?? `${YEAR} ${EVENT}`);
if (!opened) await done(1);
const playing = await waitFor('video', () => [...document.querySelectorAll('video')].map((v) => ({ t: v.currentTime, w: v.videoWidth })), (v) => v?.[0]?.t > 2 && v[0].w > 0, 90_000);
check('protected video plays', playing?.[0]?.t > 2, `${playing?.[0]?.w}px wide at ${playing?.[0]?.t?.toFixed(1)}s`);
const data = await waitFor('session data', () => window.read().sessionData.state, (s) => s === 'ready' || s === 'failed', 180_000);
check('session data is ready', data === 'ready', data);
const telemetry = await waitFor('telemetry', () => window.read().sessionData.datasets?.telemetry.state, (s) => s === 'complete' || s === 'failed', 420_000);
check('telemetry is ingested', telemetry === 'complete', telemetry);
const counts = await page.evaluate(async () => {
  const one = async (sql) => (await window.host.data.sql({ sql, asOf: 'session' })).rows[0].n;
  return { laps: await one('SELECT COUNT(*) AS n FROM laps'), car_data: await one('SELECT COUNT(*) AS n FROM car_data'), location: await one('SELECT COUNT(*) AS n FROM location') };
});
check('SQL reads the whole session', counts.laps > 500 && counts.car_data > 100_000, JSON.stringify(counts));
const refused = await page.evaluate(() => window.host.data.sql({ sql: 'DELETE FROM laps' }).then(() => 'ran', (e) => e.message));
check('SQL can only read', refused !== 'ran', String(refused).slice(0, 80));
const hidden = await page.evaluate(async () => (await window.host.data.sql({ sql: 'SELECT COUNT(*) AS n FROM laps' })).rows[0].n);
check('rows past the playhead stay hidden', hidden < counts.laps, `${hidden} of ${counts.laps} laps at the start`);

console.log('streams and charts');
// A seek only lands once the video knows how long it is.
await waitFor('the video to know its length', () => window.read().clock.end, (end) => end > 0, 90_000);
await page.evaluate(async () => {
  const { host, read } = window;
  const [row] = (await host.data.sql({ sql: 'SELECT MIN(date_start) AS start FROM laps WHERE lap_number = 25', asOf: 'session' })).rows;
  host.playback.seekToDate({ dateMs: row.start });
  const onboards = read().feeds.filter((f) => f.kind === 'onboard').slice(0, 3);
  await host.layout.add({ items: [...onboards.map((f) => ({ type: 'video', props: { feed: f.id } })), { type: 'track_map', props: {} }, { type: 'car_telemetry', props: { driver: onboards[0]?.number } }] });
});
const streams = await waitFor('streams', () => Object.values(window.read().streams).map((s) => s.status), (s) => s?.length >= 4 && s.every((x) => x === 'ready'), 120_000);
check('four streams play in sync', streams?.length >= 4 && streams.every((s) => s === 'ready'), streams?.join(' '));
// Streams that have just sought take a moment to be pulled together.
const drift = await waitFor(
  'the streams to be in sync',
  () => {
    const times = [...document.querySelectorAll('video')].map((v) => v.currentTime).filter((t) => t > 0);
    return Math.max(...times) - Math.min(...times);
  },
  (apart) => apart < 1,
  30_000,
);
check('they are within the sync threshold', drift < 1, `${drift?.toFixed(2)}s apart`);
const lap = await waitFor('the playhead to reach lap 25', () => window.read().sessionData.lapCount?.current, (current) => current >= 25, 60_000);
check('the seek landed on lap 25', lap >= 25, `lap ${lap}`);
const messages = await waitFor('the charts', () => [...document.querySelectorAll('.chart-message')].map((e) => e.textContent), (m) => m?.length === 0, 20_000);
check('the charts draw', messages?.length === 0, messages?.join(' | ') || 'no chart is waiting');
await shoot('1-streams-and-charts');

console.log('a mod');
await writeMod(source);
let list = await waitFor('the mod', () => window.f1a.mods.list(), (l) => l?.some((m) => m.name === 'lap_form' && m.state !== 'loading'), 60_000);
check('a mod compiles and loads', list?.find((m) => m.name === MOD)?.state === 'ready', JSON.stringify(list?.map((m) => `${m.name}:${m.state}`)));
await page.evaluate((MOD) => window.host.layout.add({ items: [{ type: MOD, props: {} }] }), MOD);
await sleep(2500);
check('its component is on the grid', (await page.locator(`[data-tile-type="${MOD}"]`).count()) === 1);
const picture = await page.evaluate(async (MOD) => {
  const png = await window.__f1aWeb.picture(MOD);
  return png ? Array.from(png) : null;
}, MOD);
if (picture) writeFileSync(path.join(outDir, 'picture-of-mod.png'), Buffer.from(picture));
check("the build agent's picture of it is a PNG", !!picture && picture[1] === 0x50 && picture.length > 2000, `${picture?.length ?? 0} bytes`);
await writeMod('export default (;');
list = await waitFor('the broken build', () => window.f1a.mods.list(), (l) => l?.[0]?.state === 'failed', 30_000);
const broken = list?.find((m) => m.name === MOD);
check('a broken save fails with the compiler error, and the last build keeps running', broken?.state === 'failed' && /main\.tsx:1/.test(broken.error ?? '') && (await page.locator(`[data-tile-type="${MOD}"]`).count()) === 1, (broken?.error ?? '').split('\n')[0]);
await writeMod(source);
list = await waitFor('the fixed build', () => window.f1a.mods.list(), (l) => l?.[0]?.state === 'ready', 30_000);
check('saving it fixed loads the new build', list?.find((m) => m.name === MOD)?.state === 'ready' && list[0].version >= 2, `v${list?.[0]?.version}`);
await shoot('2-mod');

console.log('build mode');
await page.evaluate((MOD) => window.host.layout.remove({ tiles: window.read().layout.tiles.filter((t) => t.component.type === MOD).map((t) => t.id) }), MOD);
await page.evaluate(() => window.f1a.build.begin());
await page.evaluate((MOD) => window.__f1aWeb.fs.rmSync(`/f1a/mods/${MOD}`, { recursive: true, force: true }), MOD);
const during = await waitFor('the change', () => window.f1a.build.state(), (s) => s?.changes?.length > 0, 20_000);
check('a build sees what changed', during?.active && during.changes[0]?.change === 'deleted', JSON.stringify(during?.changes));
const undone = await page.evaluate(() => window.f1a.build.undo());
list = await waitFor('the mod again', () => window.f1a.mods.list(), (l) => l?.some((m) => m.state === 'ready'), 30_000);
check('Undo all puts the mods folder back', undone === 1 && list?.some((m) => m.name === MOD && m.state === 'ready'), `${undone} undone`);

if (withAgent) {
  console.log('the agent (real model)');
  await borrowAgentLogin(page);
  page = await app.reload();
  await page.evaluate(() => {
    window.host.audio.setVolume({ volume: 0 });
    window.events = [];
    window.f1a.ai.onEvent((e) => window.events.push(e));
  });
  const status = await page.evaluate(() => window.f1a.ai.status());
  check('the agent is connected after a reload', status.ready, `${status.provider} ${status.model}`);
  const turn = async (text, seconds) => {
    const from = await page.evaluate(() => window.events.length);
    await typeInPalette(page, text);
    const deadline = Date.now() + seconds * 1000;
    let events = [];
    while (Date.now() < deadline) {
      await sleep(1000);
      events = (await page.evaluate(() => window.events)).slice(from);
      if (events.some((e) => e.type === 'turn_end' || e.type === 'error')) break;
    }
    return events;
  };
  const viewed = await turn(`${YEAR} ${EVENT.replace(/c$/, 'co')} race with the leader's onboard`, 150);
  const tools = viewed.filter((e) => e.type === 'tool_end' && e.ok).map((e) => e.name);
  check('the viewing agent opens the session with its tools', tools.includes('load_session') && viewed.some((e) => e.type === 'turn_end'), tools.join(', ') || viewed.find((e) => e.type === 'error')?.message);
  await waitFor('video', () => [...document.querySelectorAll('video')].map((v) => v.currentTime), (v) => v?.[0] > 1, 90_000);
  await shoot('3-agent-view');
  await typeInPalette(page, '/build');
  await sleep(2500);
  const built = await turn('Make a small tile called leader_gap that shows the gap between P1 and P2 as big text, updating with the session.', 300);
  const notes = built.filter((e) => e.type === 'tool_end' && e.note).map((e) => e.note);
  list = await mods();
  check('the build agent writes a mod that loads', list.some((m) => m.name === 'leader_gap' && m.state === 'ready') && built.some((e) => e.type === 'turn_end'), notes.join(' | ') || built.find((e) => e.type === 'error')?.message);
  await sleep(1500);
  await shoot('4-agent-build');
  console.log('  palette:', (await paletteText(page)).split('\n').slice(-3).join(' / ').slice(0, 300));
  const records = await page.evaluate(() => {
    const { fs } = window.__f1aWeb;
    const first = (folder) => {
      const files = fs.readdirSync(`/f1a/pi-agent/${folder}`).filter((f) => f.endsWith('.jsonl')).sort();
      return files.length ? JSON.parse(fs.readFileSync(`/f1a/pi-agent/${folder}/${files.at(-1)}`, 'utf8').split('\n')[0]) : null;
    };
    return [first('sessions'), first('build-sessions')];
  });
  check('each conversation is recorded in its own .jsonl', records[0]?.type === 'session' && records[0].id === 'f1a' && records[1]?.id === 'f1a-build', JSON.stringify(records.map((r) => r?.id)));
  const kept = await page.evaluate(() => window.f1a.build.save());
  check('Save keeps what it built', /leader_gap/.test(kept ?? ''), kept ?? 'nothing');
  await page.evaluate(() => window.__f1aWeb.flushFs());
}

console.log('a reload');
page = await app.reload();
list = await waitFor('mods after the reload', () => window.f1a.mods.list(), (l) => l?.length > 0 && l.every((m) => m.state !== 'loading'), 60_000);
check('mods are still there', list?.some((m) => m.name === MOD && m.state === 'ready'), JSON.stringify(list?.map((m) => `${m.name}:${m.state}`)));
check('F1 TV is still signed in', (await page.evaluate(() => window.f1a.f1tv.status())).signedIn);
const second = await app.context.newPage();
await second.goto(app.appUrl);
await sleep(2500);
check('a second tab says the app is already open', /already open/.test(await second.locator('#root').innerText()));
await second.close();
const t0 = Date.now();
await page.evaluate(
  async ({ YEAR, EVENT }) => {
    const { host } = window;
    host.audio.setVolume({ volume: 0 });
    const re = new RegExp(EVENT, 'i');
    const event = (await host.catalog.events({ year: YEAR })).find((e) => re.test(e.name) || re.test(e.shortName));
    const sessions = await host.catalog.sessions({ pageId: event.pageId, year: YEAR });
    const race = sessions.find((s) => s.type === 'race' && s.series === 'FORMULA 1') ?? sessions.find((s) => s.type === 'race');
    await host.session.open({ contentId: race.contentId, title: race.title });
  },
  { YEAR, EVENT },
);
const again = await waitFor('telemetry from the database', () => window.read().sessionData.datasets?.telemetry.state, (s) => s === 'complete', 60_000);
check('the session opens from the stored database, without ingesting again', again === 'complete' && Date.now() - t0 < 60_000, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
await shoot('5-after-reload');

console.log('the live feed');
// Between sessions F1's feed still answers a subscription with the last session's state, which is enough to
// see the socket, the capture and the database work. Live video needs a session on air: scripts/live-check.mjs.
await page.evaluate(() => window.host.session.close());
await page.evaluate(() => {
  window.statuses = [];
  window.f1a.data.onStatus((s) => window.statuses.push({ state: s.state, source: s.coverage?.source ?? null, key: s.sessionKey }));
  return window.f1a.data.open({}, true);
});
const live = await waitFor('the live capture', () => window.statuses.at(-1), (s) => s?.state === 'ready' || s?.state === 'failed', 45_000);
check('the live socket connects and a capture starts', live?.state === 'ready' && live.source === 'live', JSON.stringify(live));
await sleep(3000);
const captured = live?.key ? await page.evaluate((key) => window.f1a.data.objects(key, Date.now()).then((o) => o.drivers.length), live.key) : 0;
check('what the feed sends lands in the database', captured > 0, `${captured} drivers`);
await page.evaluate(() => window.f1a.data.close());

console.log(failures ? `${failures} FAILED` : 'all passed');
await done(failures ? 1 : 0);
