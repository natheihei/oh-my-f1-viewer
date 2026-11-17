// Checks forking an installed component in the real app, over a real replay race, with the real agent: the installed
// sources copied into the mods folder, then in build mode a change asked of a tile of an installed component, pointed
// at with @. The agent should fork it into a new mod, leave the installed one and its tile as they are, show the fork
// in the strip, and say it made a fork. Needs F1 TV signed in and the agent set up in ~/.config/oh-my-f1-viewer.
// Prints what the agent says, which could give the race away: use a session you've watched.
// With --no-agent it forks as the build agent's fork_component does, with the app's own forkComponent from
// dist-electron (run npm run build:electron first), and checks what the app does with the fork, but not the agent.
// Runs an isolated OMFV (scripts/isolated.mjs). Saves screenshots to <screenshot-dir>.
// Usage: node scripts/fork-check.mjs <screenshot-dir> [sessionKey] [year] [lap] [--no-agent]
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const withAgent = !process.argv.includes('--no-agent');
const args = process.argv.slice(2).filter((a) => a !== '--no-agent');
const outDir = args[0];
if (!outDir) throw new Error('Usage: node scripts/fork-check.mjs <screenshot-dir> [sessionKey] [year] [lap] [--no-agent]');
const [sessionKey, year, LAP] = [args[1] ? Number(args[1]) : null, Number(args[2] ?? 2026), Number(args[3] ?? 20)];
mkdirSync(outDir, { recursive: true });
const { forkComponent } = createRequire(import.meta.url)('../dist-electron/electron/mods/index.js');

const { page, log, stop, userData } = await startIsolatedApp(path.resolve(outDir), { name: 'fork', agent: withAgent });
const modsDir = path.join(userData, 'mods');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${String(detail).slice(0, 400)})` : ''}`);
};
const shot = async (name) => {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, timeout: 15_000 });
  log(`  -> ${file}`);
};
const live = (fn, arg) => page.evaluate(fn, arg);
const folders = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : []);

try {
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    window.events = [];
    window.omfv.ai.onEvent((e) => window.events.push(e));
    Object.assign(window, { host, read });
  });

  // The installed sources, copied on start.
  const installed = folders(path.join(modsDir, '.installed', 'builtin'));
  check('the app copied every installed component into .installed/builtin', installed.length === 16 && installed.includes('timing_tower'), installed.join(', '));
  const original = readFileSync(path.resolve('src/components/timing_tower/main.tsx'), 'utf8');
  const copy = () => readFileSync(path.join(modsDir, '.installed/builtin/timing_tower/main.tsx'), 'utf8');
  check('its copy is the source the app runs', copy() === original);
  const origins = await live(() => Object.fromEntries(window.read().components.map((c) => [c.name, c.origin])));
  check('live.components says the app\'s own are installed', Object.values(origins).every((o) => o === 'installed') && origins.timing_tower === 'installed', JSON.stringify(origins));

  const race = await openRace(page, { sessionKey, year });
  log(`opened ${race.title}`);
  await live(() => window.host.audio.setVolume({ volume: 0 }));
  await seekToLap(page, race.start, LAP);
  await live(() => {
    window.host.layout.add({ items: [{ type: 'timing_tower', props: {} }] });
    window.host.layout.autoLayout();
  });
  await page.waitForTimeout(3000);
  await shot('fork-01-tower');

  // Build mode, then a change to the tower's tile, pointed at with @.
  const input = page.locator('[data-testid=palette-input]');
  if (!(await input.isVisible())) await page.keyboard.press('Control+Shift+P');
  await input.fill('/build');
  await input.press('Enter');
  await page.waitForFunction(() => window.read().build.active, null, { timeout: 30_000 });
  await live(() => (window.events.length = 0));
  let reply = '';
  if (withAgent) {
    await input.click();
    await page.keyboard.type('add a column with how many pit stops each car has made to @');
    await page.keyboard.type('timing');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 600_000 });
    const events = await live(() => window.events);
    const end = events.find((e) => e.type === 'turn_end' || e.type === 'error');
    if (end.type === 'error') log(`ERROR: ${end.message}`);
    const tools = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
    const notes = events.filter((e) => e.type === 'tool_end' && e.note).map((e) => e.note);
    reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
    log(`tools: ${tools.join(' ')}`);
    log(`notes: ${notes.join(' | ')}`);
    log(`reply: ${reply}`);
    check('the agent forked it', tools.includes('fork_component'));
  } else {
    const made = await forkComponent(modsDir, 'timing_tower', 'timing_tower_pits', 'Timing · pits');
    log(`forked: ${JSON.stringify(made)}`);
    await page.waitForFunction(() => window.read().mods.find((m) => m.name === 'timing_tower_pits')?.state === 'ready', null, { timeout: 30_000 });
    // The profile has no agent: its notice would cover the strip.
    await page.getByText('Dismiss', { exact: true }).click({ timeout: 2000 }).catch(() => {});
  }
  await page.waitForTimeout(3000);

  const mods = folders(modsDir);
  const fork = mods.find((name) => readFileSync(path.join(modsDir, name, 'main.tsx'), 'utf8').startsWith('// A fork of the installed component timing_tower'));
  check('into a new mod that says what it was forked from', !!fork, mods.join(', '));
  check('the installed source is unchanged', copy() === original);
  const state = await live((fork) => {
    const { layout, mods, components, suggestions, build } = window.read();
    return {
      tiles: layout.tiles.map((t) => t.component.type),
      mod: mods.find((m) => m.name === fork) ?? null,
      origin: components.find((c) => c.name === fork)?.origin ?? null,
      drafts: suggestions.items.map((i) => i.type),
      changes: build.changes,
    };
  }, fork);
  log(`state: ${JSON.stringify(state)}`);
  check('the fork loaded, as a local component', state.mod?.state === 'ready' && state.origin === 'local', JSON.stringify(state.mod));
  check('the tower\'s tile is still the installed one', state.tiles.includes('timing_tower'));
  check('the fork is in the strip', state.drafts.includes(fork), state.drafts.join(', '));
  check('the build counts it as added', state.changes.some((c) => c.name === fork && c.change === 'added'), JSON.stringify(state.changes));
  if (withAgent) check('the reply says it is a fork', /fork|cop(y|ied)/i.test(reply), reply);
  await shot('fork-02-forked');
  // The draft from close up.
  const draft = page.locator(`[data-testid=suggestion]:has([data-draft-type="${fork}"])`);
  if (await draft.count()) {
    await draft.first().screenshot({ path: path.join(outDir, 'fork-03-draft.png') });
    log(`  -> ${path.join(outDir, 'fork-03-draft.png')}`);
  }
  // Added beside the original: two tiles, the installed one as it was and the fork marked as a draft.
  await live((fork) => {
    window.host.layout.add({ items: [{ type: fork, props: {} }] });
    window.host.layout.autoLayout();
  }, fork);
  await page.waitForTimeout(3000);
  const both = await live(() => window.read().layout.tiles.map((t) => `${t.component.type}:${t.component.key}:${t.component.label}`));
  check('the fork goes on screen beside the original, with a key of its own', both.includes('timing_tower:timing_tower:Timing') && both.some((t) => t.startsWith(`${fork}:${fork}:`)), both.join(', '));
  check('and a label of its own', !both.includes(`${fork}:${fork}:Timing`), both.join(', '));
  await shot('fork-04-side-by-side');
} catch (e) {
  failures++;
  log(`FAIL ${e.stack ?? e.message}`);
  await shot('fork-error').catch(() => {});
} finally {
  await stop();
}
log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
