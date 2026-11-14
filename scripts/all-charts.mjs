// Opens a replay race in an isolated f1a (see isolated.mjs) and puts every registered chart on screen, each
// with its driver props filled in, so every chart can be seen at once. Each chart is shot on its own as a
// tile, and manifest.json lists every chart with its args, the props it was given and its screenshot. With
// --keep, it then leaves every chart on screen and the app running, for a person to look at.
//
// Usage (the latest replay race unless --session names one): node scripts/all-charts.mjs <out-dir> [--session <key>] [--year 2026] [--lap 30] [--only a,b] [--keep]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { frontRunners, openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const outDir = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
if (!outDir) throw new Error('Usage: node scripts/all-charts.mjs <out-dir> [--session <key>] [--year 2026] [--lap 30] [--only a,b] [--keep]');
const sessionKey = flag('session', null) == null ? null : Number(flag('session'));
const year = Number(flag('year', 2026));
const targetLap = Number(flag('lap', 30));
const only = flag('only', null)?.split(',') ?? null;
const keep = argv.includes('--keep');
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'all-charts' });
let opened;
try {
  opened = await openRace(page, { sessionKey, year, telemetry: true });
} catch (e) {
  log('FAIL', e.message);
  await stop();
  process.exit(1);
}
log(`opened ${opened.title} (session ${opened.sessionKey}), circuit ${opened.circuit}`);

const charts = await page.evaluate(async () => (await import('/src/host/index.ts')).read().components.filter((c) => c.name !== 'video'));
const wanted = charts.filter((c) => !only || only.includes(c.name));
const lap = await seekToLap(page, opened.start ?? 600, targetLap);
log(`at lap ${JSON.stringify(lap)}`);

// The cars running first and second at the playhead: a battle for two-driver charts, the subject for one.
const order = await frontRunners(page);
const pool = order.length >= 2 ? order : opened.drivers.slice(0, 4);

/**
 * Props for a chart from its args: each required driver prop filled in from the front of the field, a
 * second one with the next car, and `drivers` (who to highlight) with the first two, so the whole-field
 * charts show a highlight. Other optional props are left out, so a chart draws the whole field.
 */
function propsFor(chart) {
  const properties = chart.args.properties ?? {};
  const required = new Set(chart.args.required ?? []);
  const props = {};
  let next = 0;
  for (const [name, schema] of Object.entries(properties)) {
    if (!/^drivers?(_|$)/.test(name)) continue;
    if (schema.type === 'integer' || schema.type === 'number') {
      if (required.has(name)) props[name] = pool[next++ % pool.length];
    } else if (schema.type === 'array' && (required.has(name) || name === 'drivers')) {
      props[name] = pool.slice(0, Math.min(Math.max(schema.minItems ?? 1, 2), schema.maxItems ?? 2));
    }
  }
  return props;
}

const manifest = { session: opened.title, sessionKey: opened.sessionKey, lap, drivers: pool, charts: [] };
const tower = { type: 'timing_tower', props: {} };
for (const chart of wanted) {
  const props = propsFor(chart);
  const file = `${chart.name}.png`;
  const entry = { name: chart.name, title: chart.title, description: chart.description, args: chart.args, props, file: null, message: null, error: null };
  manifest.charts.push(entry);
  try {
    // With the tower beside it, unless it is the tower, so it gets the room it would usually have.
    const items = chart.name === 'timing_tower' ? [{ type: chart.name, props }] : [tower, { type: chart.name, props }];
    await page.evaluate(async (items) => {
      const { host } = await import('/src/host/index.ts');
      host.layout.add({ items });
    }, items);
    await page.waitForTimeout(3500);
    const tile = page.locator(`[data-tile-type="${chart.name}"]`).first();
    // The palette floats over the bottom of the grid: out of the way for the shot.
    const palette = page.locator('[data-testid=palette]');
    await palette.evaluate((el) => (el.style.visibility = 'hidden'));
    await tile.screenshot({ path: path.join(outDir, file), timeout: 15_000 });
    await palette.evaluate((el) => (el.style.visibility = ''));
    entry.file = file;
    entry.message = await tile.evaluate((el) => el.querySelector('.chart-message')?.textContent ?? null);
    log(`${chart.name} ${JSON.stringify(props)}${entry.message ? `: ${entry.message}` : ''}`);
  } catch (e) {
    entry.error = String(e?.message ?? e).split('\n')[0];
    log(`${chart.name} failed: ${entry.error}`);
  }
  await page.evaluate(async () => {
    const { host, read, tilesOf } = await import('/src/host/index.ts');
    host.layout.remove({ keys: tilesOf(read().layout).filter((t) => t.component.type !== 'video').map((t) => t.component.key) });
  });
}
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
log(`wrote ${path.join(outDir, 'manifest.json')}`);

if (keep) {
  await page.evaluate(async (items) => {
    const { host } = await import('/src/host/index.ts');
    host.layout.add({ items });
  }, manifest.charts.filter((c) => !c.error).map((c) => ({ type: c.name, props: c.props })));
  log('every chart is on screen; Ctrl+C closes the app');
  // Vite keeps serving while the app is open, so it can still load what it needs.
  await new Promise((resolve) => process.once('SIGINT', resolve));
  await stop();
} else {
  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close()).catch(() => {});
  await stop();
}
