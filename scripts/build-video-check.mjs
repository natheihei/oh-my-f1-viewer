// Build mode case 27, in the real app with the real agent over a real replay race, muted: asked for a mod with
// two onboards picked in the tile, the build agent writes one that holds its videos with useStream, names what
// it shows in the title bar with useTileHeader and streamSlots, and keeps the pick with useTileState, and its
// tile plays both. Then Undo all leaves the mods folder as it was. Runs on the main profile for the agent's
// login, so it refuses while another f1a uses it. Prints what the agent says, which could give the race away.
// Usage: node scripts/build-video-check.mjs <screenshot-dir> [lap] [session key]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { MAIN_PROFILE, openRace, seekToLap, startIsolatedApp } from './isolated.mjs';
import { typeInPalette } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/build-video-check.mjs <screenshot-dir> [lap] [session key]');
const LAP = Number(process.argv[3] ?? 12);
const SESSION = process.argv[4] ? Number(process.argv[4]) : null;
const NAME = 'twin_onboards';
mkdirSync(outDir, { recursive: true });

const modsDir = path.join(MAIN_PROFILE, 'mods');
const folders = () => (existsSync(modsDir) ? readdirSync(modsDir).filter((n) => !n.startsWith('.') && statSync(path.join(modsDir, n)).isDirectory()).sort() : []);
const before = folders();
if (before.includes(NAME)) throw new Error(`The mods folder already has ${NAME}: this check writes it.`);

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'build-video', mainProfile: true });
let failed = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failed += 1;
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`);
};
const shoot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

async function say(text) {
  log(`> ${text}`);
  await page.evaluate(() => (window.events.length = 0));
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 900_000, polling: 1000 });
  await page.waitForTimeout(2000);
  const events = await page.evaluate(() => window.events);
  for (const e of events.filter((e) => e.type === 'tool_start')) log(`  tool: ${e.name}`);
  const error = events.find((e) => e.type === 'error');
  if (error) log(`  ERROR: ${error.message}`);
  log(`  reply: ${events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('')}`);
  return !error;
}

try {
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    window.events = [];
    window.f1a.ai.onEvent((e) => window.events.push(e));
    Object.assign(window, { host, read });
  });
  const race = await openRace(page, { sessionKey: SESSION });
  log(`opened ${race.title}`);
  await seekToLap(page, race.start ?? 0, LAP);

  await say(
    `/build a new mod called ${NAME}: two driver onboards stacked, beside a list of every driver in the running order. Clicking a driver in the list shows their onboard in the top picture, and the one that was there moves to the bottom one.`,
  );
  const file = path.join(modsDir, NAME, 'main.tsx');
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check('the agent wrote the mod', source.length > 0);
  check('it holds its videos with useStream', /useStream\s*\(/.test(source));
  check('it draws them with <Video stream>', /<Video\s+stream=/.test(source));
  check('its title bar says what it shows, with the stream slots', /useTileHeader\s*\(/.test(source) && /streamSlots\s*\(/.test(source));
  check('it keeps the pick with the tile', /useTileState\s*(<.*?>)?\s*\(/.test(source));
  check('the pick is not a prop', !/args:\s*Type\.Object\(\{\s*driver/.test(source));

  // Its draft waits in the strip: add it, then pick two drivers.
  const tile = await page.evaluate(async (name) => {
    const { host, read } = window;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !read().suggestions.items.some((i) => i.type === name)) await new Promise((r) => setTimeout(r, 500));
    const item = read().suggestions.items.find((i) => i.type === name);
    if (item) host.suggestions.add({ key: item.key });
    else host.layout.add({ items: [{ type: name, props: {} }] });
    await new Promise((r) => setTimeout(r, 1000));
    return read().layout.tiles.find((t) => t.component.type === name)?.id ?? null;
  }, NAME);
  check('its tile is on screen', tile != null);
  log(`tile ${tile}`);
  // Two clicks on the list's first rows, whatever the agent made them.
  const rows = page.locator(`[data-tile="${tile}"]`).locator('button, li, [role=button]');
  log(`clickable rows in the tile: ${await rows.count()}`);
  for (const i of [1, 2]) if ((await rows.count()) > i) await rows.nth(i).click().catch((e) => log(`click ${i}: ${e.message}`));
  const shown = await page.evaluate(async (tile) => {
    const deadline = Date.now() + 60_000;
    const ready = () => Object.values(window.read().streams).filter((v) => v.tile === tile && v.status === 'ready');
    while (Date.now() < deadline && ready().length < 2) await new Promise((r) => setTimeout(r, 500));
    const live = window.read();
    return { ready: ready().length, header: live.headers[tile] ?? null, health: live.health.find((h) => h.scope === tile)?.state ?? null };
  }, tile);
  check('the tile draws', shown.health === 'drawn', JSON.stringify(shown));
  check('and plays two onboards', shown.ready === 2, JSON.stringify(shown));
  check('its title bar names them', (shown.header?.drivers?.length ?? 0) === 2, JSON.stringify(shown.header));
  await shoot('build-27-twin-onboards');
  log(`source:\n${source}`);
} catch (e) {
  failed += 1;
  log('FAIL', e.message);
} finally {
  // Undo all puts the mods folder back as it was on entry.
  const undo = page.locator('[data-testid=build-undo]');
  if (await undo.count().catch(() => 0)) {
    await undo.click().catch(() => {});
    await page.waitForTimeout(3000);
  }
  check('Undo all leaves the mods folder as it was', JSON.stringify(folders()) === JSON.stringify(before), folders().join(' '));
  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close()).catch(() => {});
  await stop();
}
log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
