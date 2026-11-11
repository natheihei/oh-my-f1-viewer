// Runs a mod through its life in the real app, over a real replay race, muted: written into the mods
// folder, put on screen, saved again while playing, saved broken, made to throw, and removed. Saves a
// screenshot at each step. Uses examples/mods/lap_form and the real profile's mods folder, and removes
// the mod at the end. Needs the F1 TV sign-in.
// Usage: node scripts/mods-check.mjs <screenshot-dir> [sessionKey] [year] [lap]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/mods-check.mjs <screenshot-dir> [sessionKey] [year] [lap]');
const [sessionKey, year, lap] = [Number(process.argv[3] ?? 11396), Number(process.argv[4] ?? 2026), Number(process.argv[5] ?? 25)];
mkdirSync(outDir, { recursive: true });

const NAME = 'lap_form';
const modDir = path.join(os.homedir(), '.config', 'f1a', 'mods', NAME);
const source = readFileSync(path.resolve('examples/mods/lap_form/main.tsx'), 'utf8');
const save = (text) => writeFileSync(path.join(modDir, 'main.tsx'), text);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

rmSync(modDir, { recursive: true, force: true });
const { page, stop } = await startApp(5194);
const fail = async (message) => {
  console.log('FAIL', message);
  rmSync(modDir, { recursive: true, force: true });
  await stop();
  process.exit(1);
};

await page.evaluate(async () => {
  const { host, read } = await import('/src/host/index.ts');
  Object.assign(window, { host, read });
});
const signedIn = await page.evaluate(async () => (await window.host.account.status()).f1tv.signedIn);
if (!signedIn) await fail('F1 TV is not signed in: sign in in the app, then run this again.');

const opened = await page.evaluate(
  async ({ sessionKey, year, lap }) => {
    const { host, read } = window;
    host.audio.setVolume({ volume: 0 });
    const events = (await host.catalog.events({ year })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
    let race = null;
    for (const e of events) {
      race = (await host.catalog.sessions({ pageId: e.pageId, year })).find((s) => s.type === 'race' && String(s.sessionKey) === String(sessionKey));
      if (race) break;
    }
    if (!race) return { error: `No replay race with session key ${sessionKey} in ${year}` };
    await host.session.open({ contentId: race.contentId, title: race.title });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && (read().sessionData.state !== 'ready' || !read().clock.end)) await new Promise((r) => setTimeout(r, 500));
    if (read().sessionData.state !== 'ready') return { error: `Session data is ${read().sessionData.state}` };
    const [row] = (await host.data.sql({ sql: 'SELECT MIN(date_start) AS start FROM laps WHERE lap_number = ?', params: [lap], asOf: 'session' })).rows;
    await new Promise((r) => setTimeout(r, 3000));
    host.playback.seekToDate({ dateMs: row.start });
    host.playback.play();
    return { title: race.title };
  },
  { sessionKey, year, lap },
);
if (opened.error) await fail(opened.error);
console.log(`opened ${opened.title}, at lap ${lap}`);
await page.waitForTimeout(6000);

const modState = () => page.evaluate((name) => window.read().mods.find((m) => m.name === name) ?? null, NAME);
async function waitFor(label, test, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await modState();
    if (test(last)) return last;
    await page.waitForTimeout(200);
  }
  check(label, false, JSON.stringify(last));
  return last;
}
const tile = page.locator(`[data-tile-key="${NAME}"]`);
// By the tile's box: the stage moves its hosts every frame, so an element screenshot can wait forever for it to settle.
const shot = async (file) => {
  const clip = await tile.boundingBox();
  if (clip) await page.screenshot({ path: path.join(outDir, file), clip });
};
const viewing = () => page.evaluate(() => ({ contentId: window.read().session?.contentId, t: window.read().clock.timeSec, playing: window.read().clock.playing }));

// 1: a new folder becomes a component.
mkdirSync(modDir, { recursive: true });
save(source);
let state = await waitFor('the mod loads', (m) => m?.state === 'ready');
check('it loaded as version 1', state?.version === 1, JSON.stringify(state));
check('it is a component', await page.evaluate((name) => window.read().components.some((c) => c.name === name), NAME));

// 2: on screen.
await page.evaluate((name) => window.host.layout.add({ items: [{ type: name, props: {} }] }), NAME);
await tile.waitFor({ state: 'visible', timeout: 10_000 });
await page.waitForTimeout(2000);
check('its tile draws a canvas', (await tile.locator('canvas').count()) === 1);
await shot('mods-1-first.png');
await page.screenshot({ path: path.join(outDir, 'mods-1-window.png') });

// 3: saved again while playing: the tile redraws with the new code, and viewing carries on.
const before = await viewing();
const tileId = await tile.getAttribute('data-tile');
save(source.replace('const LAPS = 8;', 'const LAPS = 4;'));
state = await waitFor('the new save loads', (m) => m?.version === 2 && m.state === 'ready');
await page.waitForTimeout(1500);
const after = await viewing();
check('the same session is still open', after.contentId === before.contentId);
check('playback kept going', after.playing && after.t > before.t, `${before.t.toFixed(1)}s to ${after.t.toFixed(1)}s`);
check('the same tile is still there', (await tile.getAttribute('data-tile')) === tileId);
await shot('mods-2-reloaded.png');

// 4: a broken save keeps the last good version running and says why.
save(source.replace('function LapForm() {', 'function LapForm( {'));
state = await waitFor('a broken save fails', (m) => m?.state === 'failed');
check('the error names the file', /main\.tsx:\d+/.test(state?.error ?? ''), state?.error?.split('\n')[0]);
check('mod.error is written', existsSync(path.join(modDir, 'mod.error')));
check('it still runs version 2', state?.version === 2 && (await tile.locator('canvas').count()) === 1);

// 5: a mod that throws stays in its tile, and its console and error reach mod.log.
save(source.replace('function LapForm() {', "function LapForm() {\n  console.log('lap form drawing');\n  throw new Error('deliberate');"));
state = await waitFor('the throwing save loads', (m) => m?.version === 3 && m.state === 'ready');
await page.waitForTimeout(1500);
check('mod.error is gone once a save loads', !existsSync(path.join(modDir, 'mod.error')));
check('the tile shows the error', (await tile.innerText()).includes('This tile stopped: deliberate'));
check('the rest of the app still runs', (await viewing()).playing);
await page.waitForTimeout(800);
const log = existsSync(path.join(modDir, 'mod.log')) ? readFileSync(path.join(modDir, 'mod.log'), 'utf8') : '';
check('mod.log has its console output', log.includes('lap form drawing'));
check('mod.log has the render error', log.includes('Render error: Error: deliberate'));
await shot('mods-3-throwing.png');

// 6: fixed again: the tile tries the new version.
save(source);
state = await waitFor('the fix loads', (m) => m?.version === 4 && m.state === 'ready');
await page.waitForTimeout(1500);
check('the tile draws again', (await tile.locator('canvas').count()) === 1);

// 7: removed: the component and its tile go.
rmSync(modDir, { recursive: true, force: true });
await waitFor('the mod is gone', (m) => m === null);
await page.waitForTimeout(500);
check('it is no longer a component', !(await page.evaluate((name) => window.read().components.some((c) => c.name === name), NAME)));
check('its tile is gone', (await tile.count()) === 0);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
await page.evaluate(() => window.host.session.close());
await stop();
process.exit(failures ? 1 : 0);
