// Walks through charts' props in an f1a of its own (see isolated.mjs) over a real replay race, muted, and
// saves a screenshot of the window at each step: a chart suggested with its drivers filled in, a one-driver
// chart asked about rather than picked, the same chart on screen for two drivers, and the props of charts on
// screen changed in place. It checks what landed.
//
// By default it calls the agent's own tools, suggest_tiles and edit_tile, with the arguments a model would
// send: everything the agent does after the model, with no agent sign-in. With --agent it types each step
// into the palette as a user would, and the real model answers. That runs on ~/.config/f1a itself, so the
// agent's login is never copied, and refuses while another f1a is using it.
// Needs the F1 TV sign-in. Prints race data: use a race you've watched.
// Usage: node scripts/props-check.mjs <out-dir> [--agent] [--session <key>] [--year 2026] [--lap 30]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { typeInPalette } from './harness.mjs';
import { frontRunners, openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const outDir = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
if (!outDir) throw new Error('Usage: node scripts/props-check.mjs <out-dir> [--agent] [--session <key>] [--year 2026] [--lap 30]');
const agent = argv.includes('--agent');
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'props', mainProfile: agent });
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

// Who the walkthrough is about: the first three on the road, by code for the tools and by surname for the agent.
const [a, b, c] = await page.evaluate(async (numbers) => {
  const { read } = await import('/src/host/index.ts');
  const roster = read().sessionData.drivers;
  return numbers.map((n) => {
    const d = roster.find((r) => r.driver_number === n);
    return { number: n, code: d?.name_acronym ?? String(n), name: d?.last_name ?? d?.name_acronym ?? String(n) };
  });
}, (await frontRunners(page)).slice(0, 3));
log(`drivers: ${a.code} ${a.number}, ${b.code} ${b.number}, ${c.code} ${c.number}`);

await page.evaluate(async (agent) => {
  const { host, read, tilesOf } = await import('/src/host/index.ts');
  const { runTool } = await import('/src/agent/tools.ts');
  const { describeAppState } = await import('/src/agent/bridge.ts');
  Object.assign(window, { host, read, tilesOf, runTool, describeAppState });
  window.events = [];
  if (agent) {
    window.f1a.ai.onEvent((e) => window.events.push(e));
    await window.f1a.ai.reset();
  }
}, agent);
if (agent && !(await page.evaluate(async () => (await window.f1a.ai.status()).ready))) await fail('The agent is not signed in in ~/.config/f1a.');

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

/** Sends a message as the user, waits for the turn to end, and returns the tool calls, refusals and reply. */
async function say(text) {
  console.log(`\n> ${text}`);
  await page.evaluate(() => (window.events.length = 0));
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 180_000 });
  await page.waitForTimeout(1500);
  const events = await page.evaluate(() => window.events);
  const error = events.find((e) => e.type === 'error');
  const calls = events.filter((e) => e.type === 'tool_start').map((e) => ({ name: e.name, args: e.args }));
  const refused = events.filter((e) => e.type === 'tool_end' && !e.ok).map((e) => `${e.name}: ${String(e.content ?? e.message ?? '').slice(0, 200)}`);
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  if (error) console.log(`  ERROR: ${error.message}`);
  for (const call of calls) console.log(`  tool: ${call.name}(${JSON.stringify(call.args)})`);
  for (const r of refused) console.log(`  refused: ${r}`);
  console.log(`  reply: ${reply}`);
  return { ok: !error, calls, refused, reply, text: [...refused, reply].join(' ') };
}

/** One step: as the user's words with --agent, or as the tool call a model would make for them. */
const act = (words, name, args) => (agent ? say(words) : tool(name, args));

const strip = () => page.evaluate(() => window.read().suggestions.items.map((i) => ({ key: i.key, type: i.type, label: i.label, props: i.props })));
const tiles = () => page.evaluate(() => window.tilesOf(window.read().layout).map((t) => ({ id: t.id, key: t.component.key, type: t.component.type, label: t.component.label, props: t.component.props, rect: [t.x, t.y, t.w, t.h] })));
const addFromStrip = (keys) => page.evaluate((keys) => keys.forEach((key) => window.host.suggestions.add({ key })), keys);
/** The id of the tile showing a chart of this type, as app_state lists it for the model. */
const idOf = async (type) => (await tiles()).find((t) => t.type === type)?.id ?? null;
const same = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());

// 1. A battle: the suggested chart is already about both drivers.
await act(`battle between ${a.name} and ${b.name}`, 'suggest_tiles', { streams: [a.code, b.code], charts: [{ chart: 'gap_evolution', props: { driver_a: a.code, driver_b: b.code } }] });
const battle = (await strip()).find((s) => s.type === 'gap_evolution');
check('a gap chart is suggested', battle != null, (await strip()).map((s) => s.label).join(', '));
check('it is about both drivers from the start', battle != null && same([battle.props.driver_a, battle.props.driver_b], [a.number, b.number]), JSON.stringify(battle?.props));
await shot('battle-suggested');
await addFromStrip((await strip()).map((s) => s.key));

// 2. A one-driver chart with no driver named: the agent asks whose, and nothing is picked for it.
await page.evaluate(() => window.host.suggestions.newTurn());
const pedals = await act('show me the pedal chart', 'suggest_tiles', { charts: [{ chart: 'pedal_barcode' }] });
if (agent) check('the agent asks whose', /\?/.test(pedals.reply), pedals.reply);
else check('a pedal chart with no driver is refused', !pedals.ok && /needs driver.*ask the user which driver/.test(pedals.text), pedals.text);
check('no pedal chart is suggested without a driver', (await strip()).every((s) => s.type !== 'pedal_barcode' || s.props.driver != null));
if (agent) await shot('asks-whose');

// 3. The same chart twice, for two drivers.
await page.evaluate(() => window.host.suggestions.newTurn());
await act(`telemetry for ${a.name}, and another for ${b.name}`, 'suggest_tiles', { charts: [{ chart: 'car_telemetry', props: { driver: a.code } }, { chart: 'car_telemetry', props: { driver: b.code } }] });
const telemetry = (await strip()).filter((s) => s.type === 'car_telemetry');
check('a telemetry chart is suggested for each', same(telemetry.map((s) => s.props.driver), [a.number, b.number]), JSON.stringify(telemetry.map((s) => s.props)));
await addFromStrip(telemetry.map((s) => s.key));
const both = (await tiles()).filter((t) => t.type === 'car_telemetry');
check('both are on screen at once', both.length === 2, both.map((t) => t.key).join(', '));
await shot('two-telemetry');

// 4. A chart of the whole field, then who it highlights and who it draws, changed in place.
await page.evaluate(() => window.host.layout.remove({ tiles: window.tilesOf(window.read().layout).filter((t) => t.component.type === 'car_telemetry').map((t) => t.id) }));
await page.evaluate(() => window.host.layout.add({ items: [{ type: 'timing_tower', props: {} }, { type: 'tyre_strategy', props: {} }] }));
await shot('field-before');
const before = await tiles();
const appState = await page.evaluate(() => window.describeAppState());
const onScreen = appState.split('\n').find((l) => l.startsWith('on screen: ')) ?? '';
console.log(`\n  app_state ${onScreen}`);
check('app_state names every tile by its id', before.every((t) => onScreen.includes(`${t.id} ${t.label} (`)), onScreen);
await act(`highlight ${a.name} and ${b.name} in the timing tower`, 'edit_tile', { tile: await idOf('timing_tower'), props: { drivers: [a.code, b.code] } });
const tower = (await tiles()).find((t) => t.type === 'timing_tower');
check('the tower highlights both', tower != null && same(tower.props.drivers ?? [], [a.number, b.number]), JSON.stringify(tower?.props));
const towerBefore = before.find((t) => t.type === 'timing_tower');
check('the tower kept its tile and place', tower?.id === towerBefore?.id && JSON.stringify(tower?.rect) === JSON.stringify(towerBefore?.rect));
await shot('tower-highlighted');

await act(`in the tyre strategy, show only ${a.name}, ${b.name} and ${c.name}, and highlight ${a.name}`, 'edit_tile', { tile: await idOf('tyre_strategy'), props: { drivers_to_display: [a.code, b.code, c.code], drivers: [a.code] } });
const tyres = (await tiles()).find((t) => t.type === 'tyre_strategy');
check('tyre strategy draws those three', tyres != null && same(tyres.props.drivers_to_display ?? [], [a.number, b.number, c.number]), JSON.stringify(tyres?.props));
check('and highlights one of them', tyres != null && same(tyres.props.drivers ?? [], [a.number]), JSON.stringify(tyres?.props));
await shot('tyres-filtered');

// 5. Who a chart is about, changed in place.
const gapId = await idOf('gap_evolution');
await act(`switch the gap chart to ${b.name} and ${c.name}`, 'edit_tile', { tile: gapId, props: { driver_a: b.code, driver_b: c.code } });
const gap = (await tiles()).find((t) => t.type === 'gap_evolution');
check('the gap chart is now about the new pair', gap != null && same([gap.props.driver_a, gap.props.driver_b], [b.number, c.number]), JSON.stringify(gap?.props));
check('and is still the same tile, under a new key', gap?.id === gapId && gap.key !== battle?.key, `${gap?.id} ${gap?.key}`);
await shot('gap-switched');

// 6. Taking tiles off by id: a label names nothing, and the gap chart's id still does after its props changed.
if (!agent) {
  const byLabel = await tool('remove_tiles', { tiles: [gap.label] });
  check('a label is refused', !byLabel.ok && /Not on screen/.test(byLabel.text), byLabel.text);
}
await act('done with the gap chart', 'remove_tiles', { tiles: [gapId] });
check('the gap chart is off screen', (await tiles()).every((t) => t.id !== gapId), (await tiles()).map((t) => t.label).join(', '));
await shot('gap-removed');

// 7. A stream off screen by the user's words: the agent finds its tile's id in app_state.
const onboard = (await tiles()).find((t) => t.type === 'video' && t.label === b.code);
await act(`done with ${b.name}'s onboard`, 'remove_tiles', { tiles: [onboard?.id] });
check(`${b.code}'s onboard is off screen, and the rest stay`, (await tiles()).every((t) => t.id !== onboard?.id) && (await tiles()).length === 4, (await tiles()).map((t) => t.label).join(', '));
await shot('onboard-removed');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
await page.evaluate(async () => window.host.session.close()).catch(() => {});
await stop();
process.exit(failures ? 1 : 0);
