// Walks through charts' props in an isolated f1a (see isolated.mjs) over a real replay race, muted, and saves
// a screenshot of the window at each step: a chart suggested with its drivers filled in, a one-driver chart
// refused without one, the same chart on screen for two drivers, and the props of charts on screen changed
// in place. It calls the agent's own tools, suggest_tiles and edit_tile, with the arguments a model would
// send, so it runs everything the agent does after the model and needs no agent sign-in. It checks what
// landed. Needs the F1 TV sign-in. Prints race data: use a race you've watched.
// Usage: node scripts/props-check.mjs <out-dir> [--session <key>] [--year 2026] [--lap 30]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { frontRunners, openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const outDir = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
if (!outDir) throw new Error('Usage: node scripts/props-check.mjs <out-dir> [--session <key>] [--year 2026] [--lap 30]');
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'props' });
const fail = async (message) => {
  log('FAIL', message);
  await stop();
  process.exit(1);
};
process.on('uncaughtException', (e) => fail(e.message));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const opened = await openRace(page, { sessionKey: flag('session', null) == null ? null : Number(flag('session')), year: Number(flag('year', 2026)), telemetry: true }).catch((e) => fail(e.message));
log(`opened ${opened.title}, circuit ${opened.circuit}`);
const lap = await seekToLap(page, opened.start ?? 600, Number(flag('lap', 30)));
log(`at lap ${JSON.stringify(lap)}`);

// Who the walkthrough is about: the first three on the road, by code, as the user would name them.
const [a, b, c] = await page.evaluate(async (numbers) => {
  const { read } = await import('/src/host/index.ts');
  const roster = read().sessionData.drivers;
  return numbers.map((n) => ({ number: n, code: roster.find((d) => d.driver_number === n)?.name_acronym ?? String(n) }));
}, (await frontRunners(page)).slice(0, 3));
log(`drivers: ${a.code} ${a.number}, ${b.code} ${b.number}, ${c.code} ${c.number}`);

await page.evaluate(async () => {
  const { host, read, tilesOf } = await import('/src/host/index.ts');
  const { runTool } = await import('/src/agent/tools.ts');
  Object.assign(window, { host, read, tilesOf, runTool });
});

let step = 0;
const shot = async (name) => {
  step += 1;
  const file = path.join(outDir, `${step}-${name}.png`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: file });
  log(`saved ${file}`);
};

/** Calls one of the agent's tools as the model would, and returns what it tells the model, or its refusal. */
async function tool(name, args) {
  const out = await page.evaluate(async ({ name, args }) => {
    try {
      return { ok: true, text: await window.runTool(name, args) };
    } catch (e) {
      return { ok: false, text: e.message };
    }
  }, { name, args });
  console.log(`\n> ${name}(${JSON.stringify(args)})\n  ${out.ok ? 'result' : 'refused'}: ${out.text}`);
  return out;
}

const strip = () => page.evaluate(() => window.read().suggestions.items.map((i) => ({ key: i.key, type: i.type, label: i.label, props: i.props })));
const tiles = () => page.evaluate(() => window.tilesOf(window.read().layout).map((t) => ({ id: t.id, key: t.component.key, type: t.component.type, label: t.component.label, props: t.component.props, rect: [t.x, t.y, t.w, t.h] })));
const addFromStrip = (keys) => page.evaluate((keys) => keys.forEach((key) => window.host.suggestions.add({ key })), keys);
const same = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());

// 1. A battle: the suggested chart is already about both drivers.
await tool('suggest_tiles', { streams: [a.code, b.code], charts: [{ chart: 'gap_evolution', props: { driver_a: a.code, driver_b: b.code } }] });
const battle = (await strip()).find((s) => s.type === 'gap_evolution');
check('a gap chart is suggested', battle != null, (await strip()).map((s) => s.label).join(', '));
check('it is about both drivers from the start', battle != null && same([battle.props.driver_a, battle.props.driver_b], [a.number, b.number]), JSON.stringify(battle?.props));
await shot('battle-suggested');
await addFromStrip((await strip()).map((s) => s.key));

// 2. A one-driver chart with no driver named: refused, with word to ask whose, and nothing picked.
const pedals = await tool('suggest_tiles', { charts: [{ chart: 'pedal_barcode' }] });
check('a pedal chart with no driver is refused', !pedals.ok && /needs driver.*ask the user which driver/.test(pedals.text), pedals.text);
check('and nothing is suggested', !(await strip()).some((s) => s.type === 'pedal_barcode'));

// 3. The same chart twice, for two drivers.
await tool('suggest_tiles', { charts: [{ chart: 'car_telemetry', props: { driver: a.code } }, { chart: 'car_telemetry', props: { driver: b.code } }] });
const telemetry = (await strip()).filter((s) => s.type === 'car_telemetry');
check('a telemetry chart is suggested for each', same(telemetry.map((s) => s.props.driver), [a.number, b.number]), JSON.stringify(telemetry.map((s) => s.props)));
await addFromStrip(telemetry.map((s) => s.key));
const both = (await tiles()).filter((t) => t.type === 'car_telemetry');
check('both are on screen at once', both.length === 2, both.map((t) => t.key).join(', '));
await shot('two-telemetry');

// 4. A chart of the whole field, then who it highlights and who it draws, changed in place.
await page.evaluate(() => window.host.layout.remove({ keys: window.tilesOf(window.read().layout).filter((t) => t.component.type === 'car_telemetry').map((t) => t.component.key) }));
await page.evaluate(() => window.host.layout.add({ items: [{ type: 'timing_tower', props: {} }, { type: 'tyre_strategy', props: {} }] }));
await shot('field-before');
const before = await tiles();
await tool('edit_tile', { tile: 'timing_tower', props: { drivers: [a.code, b.code] } });
const tower = (await tiles()).find((t) => t.type === 'timing_tower');
check('the tower highlights both', tower != null && same(tower.props.drivers ?? [], [a.number, b.number]), JSON.stringify(tower?.props));
const towerBefore = before.find((t) => t.type === 'timing_tower');
check('the tower kept its tile and place', tower?.id === towerBefore?.id && JSON.stringify(tower?.rect) === JSON.stringify(towerBefore?.rect));
await shot('tower-highlighted');

await tool('edit_tile', { tile: 'Tyre strategy', props: { drivers_to_display: [a.code, b.code, c.code], drivers: [a.code] } });
const tyres = (await tiles()).find((t) => t.type === 'tyre_strategy');
check('tyre strategy draws those three', tyres != null && same(tyres.props.drivers_to_display ?? [], [a.number, b.number, c.number]), JSON.stringify(tyres?.props));
check('and highlights one of them', tyres != null && same(tyres.props.drivers ?? [], [a.number]), JSON.stringify(tyres?.props));
await shot('tyres-filtered');

// 5. Who a chart is about, changed in place.
await tool('edit_tile', { tile: 'gap_evolution', props: { driver_a: b.code, driver_b: c.code } });
const gap = (await tiles()).find((t) => t.type === 'gap_evolution');
check('the gap chart is now about the new pair', gap != null && same([gap.props.driver_a, gap.props.driver_b], [b.number, c.number]), JSON.stringify(gap?.props));
await shot('gap-switched');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
await page.evaluate(async () => window.host.session.close()).catch(() => {});
await stop();
process.exit(failures ? 1 : 0);
