// Checks car telemetry in the real app over a real replay race, muted: alone beside the main feed, under its
// driver's onboard, among other tiles, at its least size and squeezed below it. Shoots once while the car is
// chasing within a second of the one ahead and once in clear air. Prints each tile's size, the size the chart
// draws at, the host's mark and the chip's interval, and saves a screenshot of each.
//
// The app is launched on Hyprland on workspace 3, floating and without focus (elsewhere as an ordinary window), with its own user data
// (the F1 TV sign-in copied in), and driven over CDP. It waits for the session's telemetry to load.
// Run `npm run build:electron` first in a fresh checkout.
// Usage: node scripts/telemetry-check.mjs <screenshot-dir> [car] [session key] [vite port] [cdp port]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { MAIN_PROFILE, startElectron } from './platform.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/telemetry-check.mjs <screenshot-dir> [car] [session key] [vite port] [cdp port]');
const CAR = Number(process.argv[3] ?? 3);
const SESSION = String(process.argv[4] ?? 11412);
const PORT = Number(process.argv[5] ?? 5199);
const CDP = Number(process.argv[6] ?? 9339);
mkdirSync(outDir, { recursive: true });
const scratch = process.env.OMFV_SCRATCH ?? tmpdir();
const userData = mkdtempSync(path.join(scratch, 'omfv-telemetry-'));
for (const f of ['omfv-session.json', 'omfv-cookies.json']) copyFileSync(path.join(MAIN_PROFILE, f), path.join(userData, f));

const server = await createServer({ server: { port: PORT, strictPort: true }, cacheDir: path.join(userData, 'vite'), logLevel: 'error' });
await server.listen();
startElectron([path.resolve('.'), `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP}`], { env: { ELECTRON_START_URL: `http://127.0.0.1:${PORT}` } });
let browser;
for (let i = 0; i < 120 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null);
  if (!browser) await new Promise((r) => setTimeout(r, 500));
}
if (!browser) throw new Error('the app did not open its debugging port: is dist-electron built?');
let page;
for (let i = 0; i < 120 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${PORT}`));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
// A hidden workspace stops producing frames once nothing moves: a tiny animation keeps screenshots working.
await page.addStyleTag({ content: '@keyframes omfv-tick{to{opacity:.99}} body::after{content:"";position:fixed;width:1px;height:1px;animation:omfv-tick 1s infinite alternate}' });

const done = async (code = 0) => {
  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close()).catch(() => {});
  await browser.close().catch(() => {});
  try {
    execFileSync('pkill', ['-f', '--', `user-data-dir=${userData}`]);
  } catch {}
  await server.close();
  process.exit(code);
};

const opened = await page.evaluate(async (sessionKey) => {
  const { host, read } = await import('/src/host/index.ts');
  if (!(await host.account.status()).f1tv.signedIn) return { error: 'F1 TV is not signed in' };
  host.audio.setVolume({ volume: 0 });
  const events = (await host.catalog.events({ year: 2026 })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
  let race = null;
  for (const e of events) {
    race = (await host.catalog.sessions({ pageId: e.pageId, year: 2026 })).find((s) => s.type === 'race' && s.sessionKey === sessionKey);
    if (race) break;
  }
  if (!race) return { error: `no replay race with session key ${sessionKey}` };
  await host.session.open({ contentId: race.contentId, title: race.title });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
  const loaded = Date.now() + 420_000;
  while (Date.now() < loaded && read().sessionData.datasets?.telemetry.state !== 'complete') await new Promise((r) => setTimeout(r, 1000));
  return { title: race.title, telemetry: read().sessionData.datasets?.telemetry.state, feeds: read().feeds.map((f) => ({ id: f.id, kind: f.kind, number: f.number })) };
}, SESSION);
if (opened.error || opened.telemetry !== 'complete') {
  console.log('FAIL', opened.error ?? `telemetry is ${opened.telemetry}`);
  await done(1);
}
console.log(`opened ${opened.title}`);

/** The moments to shoot: the car's laps where it's chasing within a second, and where it's furthest from that. */
const moments = await page.evaluate(async (car) => {
  const { host } = await import('/src/host/index.ts');
  const sql = async (s, params) => (await host.data.sql({ sql: s, params, asOf: 'session' })).rows;
  const laps = await sql('SELECT lap_number, date_start FROM laps WHERE driver_number = ?1 AND date_start IS NOT NULL ORDER BY lap_number', [car]);
  const iv = await sql('SELECT date, interval FROM intervals WHERE driver_number = ?1 ORDER BY date', [car]);
  const mid = laps.slice(3, -2).map((l) => ({ lap: l.lap_number, at: l.date_start + 40_000 }));
  const intervalAt = (at) => iv.filter((r) => r.date <= at).at(-1)?.interval;
  const chasing = mid.find((m) => typeof intervalAt(m.at) === 'number' && intervalAt(m.at) < 1);
  const clear = mid.filter((m) => typeof intervalAt(m.at) === 'number').sort((a, b) => intervalAt(b.at) - intervalAt(a.at))[0];
  return [chasing && { name: 'chasing', ...chasing }, clear && { name: 'clear', ...clear }].filter(Boolean);
}, CAR);

async function seekToMs(ms) {
  await page.evaluate(async (ms) => {
    const { host, read } = await import('/src/host/index.ts');
    const ready = Date.now() + 60_000;
    while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
    // Video seconds from the playhead's milliseconds, by the offset between the two now.
    const time = read().clock.timeSec + (ms - read().sessionData.playheadMs) / 1000;
    host.playback.play();
    await host.playback.seek({ time });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && Math.abs(read().clock.timeSec - time) > 3) await new Promise((r) => setTimeout(r, 300));
    host.playback.pause();
  }, ms);
  await page.waitForTimeout(4000);
  return page.evaluate(async () => (await import('/src/host/index.ts')).read().sessionData.lapCount);
}

const measure = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.chart-canvas')].map((canvas) => {
      const frame = canvas.closest('.view-frame');
      const mark = frame?.parentElement?.querySelector('[data-testid=overflow-mark]');
      return { tile: frame && [frame.clientWidth, frame.clientHeight], drawn: [canvas.clientWidth, canvas.clientHeight], mark: mark ? mark.textContent.trim() : null };
    }),
  );

async function shoot(name, items, squeeze) {
  await page.evaluate(async (items) => {
    const { host, read, tilesOf } = await import('/src/host/index.ts');
    host.layout.remove({ tiles: tilesOf(read().layout).filter((t) => t.component.type !== 'video' || !read().feeds.some((f) => f.id === t.component.props.feed && f.kind === 'main')).map((t) => t.id) });
    host.layout.add({ items });
    host.layout.autoLayout();
  }, items);
  await page.waitForTimeout(2500);
  if (squeeze) {
    // By hand, to about this many pixels.
    await page.evaluate(async ([width, height]) => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      const t = tilesOf(read().layout).find((x) => x.component.type === 'car_telemetry');
      // The only chart on screen here.
      const el = document.querySelector('.chart-canvas').closest('.view-frame');
      const cw = el.clientWidth / t.w;
      const chh = (el.clientHeight + 25) / t.h;
      host.layout.move({ tile: t.id, rect: { x: t.x, y: t.y, w: Math.max(1, Math.round(width / cw)), h: Math.max(1, Math.round(height / chh)) } });
    }, squeeze);
    await page.waitForTimeout(2500);
  }
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${JSON.stringify(await measure())} -> ${file}`);
}

const telemetry = { type: 'car_telemetry', props: { driver: CAR } };
const feed = opened.feeds.find((f) => f.kind === 'onboard' && f.number === CAR);
const onboard = feed ? [{ type: 'video', props: { feed: feed.id } }] : [];
console.log(`onboard: ${feed?.id ?? 'none found'}`);

for (const [i, m] of moments.entries()) {
  console.log(`${m.name}: lap ${JSON.stringify(await seekToMs(m.at))}`);
  await shoot(`${m.name}-1-alone`, [telemetry]);
  await shoot(`${m.name}-2-under-onboard`, [...onboard, telemetry]);
  if (i > 0) continue;
  await shoot(`${m.name}-3-crowded`, [...onboard, telemetry, { type: 'timing_tower', props: {} }, { type: 'track_map', props: {} }]);
  await shoot(`${m.name}-4-least`, [...onboard, telemetry], [300, 150]);
  await shoot(`${m.name}-5-squeezed`, [...onboard, telemetry], [220, 110]);
}
// Once more on the brake, so its colour shows: step on from the last moment until the car is braking.
for (let i = 0; i < 40; i++) {
  const braking = await page.evaluate(async (car) => {
    const { host, read } = await import('/src/host/index.ts');
    const { rows } = await host.data.sql({ sql: 'SELECT brake FROM car_data WHERE driver_number = ?1 AND date > ?2 - 2000 ORDER BY date DESC LIMIT 1', params: [car, read().sessionData.playheadMs] });
    return rows[0]?.brake === 100;
  }, CAR);
  if (braking) break;
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    await host.playback.seek({ time: read().clock.timeSec + 0.7 });
  });
  await page.waitForTimeout(1200);
}
await shoot('braking-under-onboard', [...onboard, telemetry]);
await done(0);
