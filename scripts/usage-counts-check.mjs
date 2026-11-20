// Runs the app from the source, a dev build, which logs each usage count to the main process's output (tagged
// `build: dev`). It sends nothing: the check's app never gets OMFV_POSTHOG_KEY. Then it checks what a viewer does produces the counts docs/TELEMETRY.md lists: nothing until the palette's notice has
// shown, then the install and the start, a session opened and closed, the tiles on it, and the `/` commands. It ends by
// turning the counts off and checking nothing more goes out. Needs the F1 TV login in the main profile.
//
// Usage: npm run build:electron && node scripts/usage-counts-check.mjs <output-dir>
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openRace, startIsolatedApp } from './isolated.mjs';

const outDir = process.argv[2] && path.resolve(process.argv[2]);
if (!outDir) throw new Error('Usage: node scripts/usage-counts-check.mjs <output-dir>');
mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

/** The counts main has logged so far, in order. */
const counted = () =>
  readFileSync(path.join(outDir, 'main.log'), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const m = /^\[telemetry\] (\w+) (\{.*\})$/.exec(line.trim());
      return m ? [{ event: m[1], props: JSON.parse(m[2]) }] : [];
    });
const names = () => counted().map((c) => c.event);
const waitFor = async (what, ok, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const { page, stop, userData } = await startIsolatedApp(outDir, { name: 'usage-counts' });
const settings = () => JSON.parse(readFileSync(path.join(userData, 'omfv-settings.json'), 'utf8'));
const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const input = page.locator('[data-testid=palette-input]');
const run = async (line) => {
  if (!(await input.isVisible())) await page.keyboard.press('Control+K');
  await input.fill(line);
  await input.press('Enter');
  await page.waitForTimeout(800);
};
const paletteText = () => page.locator('[data-testid=palette]').innerText();

try {
  // The notice, once, and nothing sent before it.
  const noticed = await waitFor('the notice', () => names().includes('app_started'));
  const text = await paletteText();
  check('the palette says counts are on, and how to turn them off', text.includes('anonymous usage counts') && text.includes('/settings-usage off'));
  check('the install and the start are counted once the notice shows', noticed && names().slice(0, 2).join() === 'app_installed,app_started', names().join(', '));
  const started = counted().find((c) => c.event === 'app_started');
  check('every event says it is a dev build, and asks for no person profile', started?.props.build === 'dev' && started?.props.install === 'checkout' && started?.props.$process_person_profile === false, JSON.stringify(started?.props));
  check('the id is a random UUID in the settings', /^[0-9a-f-]{36}$/.test(settings().telemetry?.id ?? ''), JSON.stringify(settings().telemetry));
  await shot('telemetry-01-notice');

  // A session: opened, its video tile, a chart, and closed.
  const race = await openRace(page);
  await page.evaluate(async () => {
    const { host } = await import('/src/host/index.ts');
    host.layout.add({ items: [{ type: 'timing_tower', props: {} }] });
  });
  await waitFor('the tiles', () => names().filter((n) => n === 'tile_added').length >= 2);
  const opened = counted().find((c) => c.event === 'session_opened');
  check(`opening ${race.title} counts its type, year and that it's a replay, not its title`, opened && opened.props.session_type === 'race' && opened.props.live === false && opened.props.year === 2026 && !JSON.stringify(opened.props).includes(race.title), JSON.stringify(opened?.props));
  const tiles = counted().filter((c) => c.event === 'tile_added').map((c) => c.props.tile);
  check('the tiles are counted by component', tiles.includes('video') && tiles.includes('timing_tower'), tiles.join(', '));

  await run('/settings-usage');
  check('/settings-usage thanks the viewer while they are on', (await paletteText()).includes('Thanks for helping me see how OMFV is used.'));
  check('the command is counted by its name', counted().some((c) => c.event === 'command_used' && c.props.command === '/settings-usage'));
  await shot('telemetry-02-status');

  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close());
  check('closing the session counts its minutes', await waitFor('the close', () => counted().some((c) => c.event === 'session_closed' && typeof c.props.minutes === 'number')));

  // Off: the id goes, and nothing more is counted.
  await run('/settings-usage off');
  const before = counted().length;
  check('off forgets the id', JSON.stringify(settings().telemetry) === JSON.stringify({ enabled: false, noticed: true }), JSON.stringify(settings().telemetry));
  await run('/version');
  await page.waitForTimeout(1000);
  check('nothing is counted once off', counted().length === before, names().slice(before).join(', '));
  await shot('telemetry-03-off');
} finally {
  await stop();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
