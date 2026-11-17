// Checks how build mode marks a tile in the real app, over a real replay race, with no agent: an edited mod's
// tile is framed with its header lit, as a tile pointed at with @ is, and doesn't dim the others; pointing at
// another tile still dims it. The mod is edited on disk by hand, since the marks follow the folder.
// Runs an isolated f1a (scripts/isolated.mjs). Saves a screenshot at each step.
// Usage: node scripts/build-mark-check.mjs <screenshot-dir> [--keep]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRace, startIsolatedApp } from './isolated.mjs';
import { typeInPalette } from './harness.mjs';

const keep = process.argv.includes('--keep');
const outDir = process.argv.filter((a) => a !== '--keep')[2];
if (!outDir) throw new Error('Usage: node scripts/build-mark-check.mjs <screenshot-dir> [--keep]');
mkdirSync(outDir, { recursive: true });

const { page, log, stop, userData } = await startIsolatedApp(path.resolve(outDir), { name: 'build-mark' });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};
const finish = async () => {
  log(failed ? `${failed} failed` : 'all passed');
  if (!keep) await stop();
  process.exit(failed ? 1 : 0);
};
for (const event of ['unhandledRejection', 'uncaughtException'])
  process.on(event, async (e) => {
    log('FAIL', e);
    failed++;
    await finish();
  });
const until = async (what, ok, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ok().catch(() => false)) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`timed out: ${what}`);
};

const LAP_FORM = readFileSync(path.resolve('examples/mods/lap_form/main.tsx'), 'utf8');
const form = path.join(userData, 'mods', 'lap_form');
mkdirSync(form, { recursive: true });
writeFileSync(path.join(form, 'main.tsx'), LAP_FORM);

const race = await openRace(page);
log(`opened ${race.title}`);
const modReady = () => page.evaluate(async () => (await import('/src/host/index.ts')).read().mods.find((m) => m.name === 'lap_form')?.state === 'ready');
await until('lap_form loads', modReady);
await page.evaluate(async () => {
  const { host } = await import('/src/host/index.ts');
  host.layout.add({ items: [{ type: 'lap_form', props: {} }, { type: 'timing_tower', props: {} }] });
  host.layout.autoLayout();
});
await page.waitForTimeout(3000);

/** Each tile's type, and whether it's marked, pointed, dimmed, and how its frame and title bar are drawn. */
const looks = () =>
  page.evaluate(async () => {
    const { read } = await import('/src/host/index.ts');
    return read().layout.tiles.map((t) => {
      const item = document.querySelector(`.grid-stack-item[gs-id="${t.id}"]`);
      const frame = getComputedStyle(item.querySelector('.grid-stack-item-content'), '::before');
      return {
        id: t.id,
        type: t.component.type,
        marked: item.classList.contains('tile-marked'),
        pointed: item.classList.contains('tile-pointed'),
        dimmed: item.classList.contains('tile-dimmed'),
        frame: frame.content === 'none' ? null : `${frame.borderTopWidth} ${frame.borderTopStyle} ${frame.borderTopColor}`,
        bar: getComputedStyle(item.querySelector('.tile-titlebar')).backgroundColor,
        outline: getComputedStyle(document.querySelector(`.stage-host[data-tile="${t.id}"]`), '::after').borderTopStyle,
        slot: item.querySelector('.tile-slot-mark:not([hidden])')?.textContent ?? null,
      };
    });
  });

const before = await looks();
check('before building, no tile is marked', before.every((t) => !t.marked && t.frame == null), JSON.stringify(before));
await page.screenshot({ path: path.join(outDir, 'mark-01-before.png') });

await typeInPalette(page, '/build');
await until('build mode is on', () => page.evaluate(async () => (await import('/src/host/index.ts')).read().build.active));
writeFileSync(path.join(form, 'main.tsx'), LAP_FORM.replace('const LAPS = 8;', 'const LAPS = 12;'));
await until('lap_form is marked edited', async () => (await looks()).find((t) => t.type === 'lap_form')?.marked);
await page.waitForTimeout(1500);

const edited = await looks();
const lap = edited.find((t) => t.type === 'lap_form');
const others = edited.filter((t) => t.type !== 'lap_form');
check('the edited tile says "edited"', lap.slot === 'edited', lap.slot);
check('the edited tile has a 2px solid frame', /^2px solid/.test(lap.frame ?? ''), lap.frame);
check('its content has no dashed outline', lap.outline !== 'dashed', lap.outline);
check('the other tiles stay unmarked and undimmed', others.every((t) => !t.marked && !t.dimmed && t.frame == null), JSON.stringify(others));
await page.screenshot({ path: path.join(outDir, 'mark-02-edited.png') });

// Pointing at another tile: it gets the same look, and the spotlight dims everything else, the edited tile too.
const tower = others.find((t) => t.type === 'timing_tower');
await page.evaluate(async (id) => (await import('/src/host/index.ts')).host.layout.point({ tile: id }), tower.id);
await page.waitForTimeout(800);
const pointing = await looks();
const pt = pointing.find((t) => t.id === tower.id);
const lap2 = pointing.find((t) => t.type === 'lap_form');
check('the pointed tile looks like the edited one did', pt.pointed && pt.frame === lap.frame && pt.bar === lap.bar, `${pt.frame} ${pt.bar}`);
check('the edited tile is dimmed under the spotlight, still marked', lap2.dimmed && lap2.marked, JSON.stringify(lap2));
await page.screenshot({ path: path.join(outDir, 'mark-03-pointed.png') });
await page.evaluate(async () => (await import('/src/host/index.ts')).host.layout.point({ tile: null }));

await finish();
