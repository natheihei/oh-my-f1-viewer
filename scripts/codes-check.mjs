// Checks driver codes in the real app over a real replay race, muted, late in the race so race control has
// plenty to say: tile titles that name drivers (an onboard carrying the sound among them), the tables, the
// charts' own headings and plot labels, and race control's lines. Saves a screenshot of each layout, and
// prints each title bar's text and the codes it draws.
//
// Launched as scripts/tower-check.mjs is: through Hyprland on workspace 3, floating and without focus, with
// its own user data (the F1 TV sign-in copied in), and driven over CDP.
// Usage: node scripts/codes-check.mjs <screenshot-dir> <race, by name> [--keep]
//   e.g. node scripts/codes-check.mjs shots mexico
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const keep = process.argv.includes('--keep');
const args = process.argv.filter((a) => a !== '--keep');
const outDir = args[2];
const raceName = args[3] ?? '';
if (!outDir) throw new Error('Usage: node scripts/codes-check.mjs <screenshot-dir> <race>');
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(process.env.F1A_SCRATCH ?? tmpdir(), 'f1a-codes-'));
for (const f of ['f1a-session.json', 'f1a-cookies.json']) copyFileSync(path.join(homedir(), '.config/f1a', f), path.join(userData, f));

const PORT = 5231;
const CDP = 9371;
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const electronBin = path.resolve('node_modules/electron/dist/electron');
const cmd = `env -u CHROME_DESKTOP ELECTRON_START_URL=http://127.0.0.1:${PORT} ${electronBin} ${path.resolve('.')} --user-data-dir=${userData} --remote-debugging-port=${CDP}`;
execFileSync('hyprctl', ['eval', `hl.exec_cmd(${JSON.stringify(cmd)}, { workspace = "3 silent", float = true, size = "1600 900", no_initial_focus = true })`]);
let browser;
for (let i = 0; i < 120 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null);
  if (!browser) await new Promise((r) => setTimeout(r, 500));
}
if (!browser) throw new Error('the app did not open its debugging port');
let page;
for (let i = 0; i < 120 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${PORT}`));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
// A hidden workspace stops producing frames once nothing moves: a tiny animation keeps screenshots working.
await page.addStyleTag({ content: '@keyframes f1a-tick{to{opacity:.99}} body::after{content:"";position:fixed;width:1px;height:1px;animation:f1a-tick 1s infinite alternate}' });

const done = async (code = 0) => {
  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close()).catch(() => {});
  await browser.close().catch(() => {});
  try {
    execFileSync('pkill', ['-f', '--', `user-data-dir=${userData}`]);
  } catch {}
  await server.close();
  process.exit(code);
};
for (const event of ['unhandledRejection', 'uncaughtException'])
  process.on(event, async (e) => {
    console.log('FAIL', e);
    await done(1);
  });

const opened = await page.evaluate(async (raceName) => {
  const { host, read } = await import('/src/host/index.ts');
  if (!(await host.account.status()).f1tv.signedIn) return { error: 'F1 TV is not signed in' };
  host.audio.setVolume({ volume: 0 });
  const events = (await host.catalog.events({ year: 2026 })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
  let race = null;
  for (const e of events) {
    race = (await host.catalog.sessions({ pageId: e.pageId, year: 2026 })).find((s) => s.type === 'race' && `${e.name} ${e.shortName} ${s.title}`.toLowerCase().includes(raceName.toLowerCase()));
    if (race) break;
  }
  if (!race) return { error: `no replay race matching "${raceName}"` };
  await host.session.open({ contentId: race.contentId, title: race.title });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
  const ready = Date.now() + 60_000;
  while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
  // Late in the race, after the stewards' last word, so race control has a full log.
  const {
    rows: [row],
  } = await host.data.sql({ sql: "SELECT date, lap_number FROM race_control WHERE message LIKE 'FIA STEWARDS:%' ORDER BY date DESC LIMIT 1", asOf: 'session' });
  if (row) {
    host.playback.play();
    host.playback.seekToDate({ dateMs: row.date + 4000 });
    await new Promise((r) => setTimeout(r, 3000));
    host.playback.pause();
  }
  return { title: `${race.title} (${race.sessionKey})`, lap: row?.lap_number ?? null, feeds: read().feeds.map((f) => ({ id: f.id, kind: f.kind, number: f.number, label: f.label })) };
}, raceName);
if (opened.error) {
  console.log('FAIL', opened.error);
  await done(1);
}
console.log(`opened ${opened.title} at lap ${opened.lap}`);
const onboard = opened.feeds.find((f) => f.kind === 'onboard' && f.number === 44) ?? opened.feeds.find((f) => f.kind === 'onboard');

/** Every title bar's text, and the codes it draws as driver codes. */
const titles = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.tile-title')].map((t) => ({
      text: t.textContent,
      codes: [...t.querySelectorAll('.driver-code')].map((c) => `${c.textContent}(${c.className.replace(/driver-code-?/g, '').trim()})`),
    })),
  );

async function shoot(name, items, audio) {
  await page.evaluate(
    async ([items, audio]) => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      host.layout.remove({ tiles: tilesOf(read().layout).map((t) => t.id) });
      host.layout.add({ items });
      host.layout.autoLayout();
      if (audio) {
        // The video of that feed, once its tile holds one.
        const deadline = Date.now() + 10_000;
        let video = null;
        while (Date.now() < deadline && !(video = Object.values(read().streams).find((v) => v.feed === audio && v.tile))) await new Promise((r) => setTimeout(r, 200));
        if (video) host.audio.set({ video: video.id });
      }
    },
    [items, audio ?? null],
  );
  await page.waitForTimeout(4000);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name} -> ${file}`);
  for (const t of await titles()) console.log(`  ${t.text}${t.codes.length ? `  [${t.codes.join(', ')}]` : ''}`);
}

const main = opened.feeds.find((f) => f.kind === 'main');
await shoot(
  '1-titles-tower-race-control',
  [
    ...(main ? [{ type: 'video', props: { feed: main.id } }] : []),
    ...(onboard ? [{ type: 'video', props: { feed: onboard.id } }] : []),
    { type: 'car_telemetry', props: { driver: 44 } },
    { type: 'gap_evolution', props: { driver_a: 1, driver_b: 81 } },
    { type: 'timing_tower', props: {} },
    { type: 'race_control', props: {} },
  ],
  onboard?.id,
);
await shoot('2-charts', [
  { type: 'pit_window', props: { driver: 44 } },
  { type: 'track_map', props: { drivers: [1, 81] } },
  { type: 'pedal_barcode', props: {} },
  { type: 'sector_table', props: { driver_a: 1, driver_b: 81 } },
  { type: 'race_status', props: {} },
  { type: 'pit_windows', props: {} },
]);
await shoot('3-tyres', [
  { type: 'tyre_strategy', props: {} },
  { type: 'tyre_deg', props: {} },
  { type: 'speed_ribbon', props: { driver: 44 } },
]);

if (keep) {
  console.log(`left open: user data in ${userData}. Serving it until the app is closed.`);
  page.on('close', () => done(0));
  browser.on('disconnected', () => done(0));
} else await done(0);
