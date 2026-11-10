// Uses the real app the way an outside agent would: only through bin/f1a-mcp, as an MCP client. It finds
// and opens a replay race, mutes it, jumps to a lap, builds a mod from examples/mods/lap_form, checks it,
// puts it on screen, looks at it, saves a change and a broken version, and removes it. Saves each
// screenshot. Uses the real profile's mods folder, and removes the mod at the end. Needs the F1 TV sign-in.
// Usage: node scripts/mcp-check.mjs <screenshot-dir> [year] [event name] [lap]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startApp } from './harness.mjs';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/mcp-check.mjs <screenshot-dir> [year] [event name] [lap]');
const [year, eventName, lap] = [Number(process.argv[3] ?? 2026), process.argv[4] ?? 'MÉXICO', Number(process.argv[5] ?? 30)];
mkdirSync(outDir, { recursive: true });

const NAME = 'mcp_check';
const modDir = path.join(os.homedir(), '.config', 'f1a', 'mods', NAME);
const source = readFileSync(path.resolve('examples/mods/lap_form/main.tsx'), 'utf8')
  .replaceAll("'lap_form'", `'${NAME}'`)
  .replace("title: 'Lap form'", "title: 'MCP check'");
const save = (text) => writeFileSync(path.join(modDir, 'main.tsx'), text);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

rmSync(modDir, { recursive: true, force: true });
// The agent connects first: its tools appear once the app is up.
const client = new Client({ name: 'mcp-check', version: '0' });
await client.connect(new StdioClientTransport({ command: path.resolve('bin/f1a-mcp') }));
check('with the app down there are no tools', (await client.listTools()).tools.length === 0);
const { stop } = await startApp(5197);
const finish = async (code) => {
  rmSync(modDir, { recursive: true, force: true });
  await client.close();
  await stop();
  process.exit(code);
};

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const textPart = res.content.find((c) => c.type === 'text')?.text ?? '';
  const image = res.content.find((c) => c.type === 'image');
  let value = textPart;
  try {
    value = JSON.parse(textPart);
  } catch {}
  return { error: res.isError ? textPart : null, value, image };
}
const must = async (name, args) => {
  const r = await call(name, args);
  if (r.error) {
    console.log(`FAIL ${name}: ${r.error}`);
    await finish(1);
  }
  return r.value;
};

let tools = [];
for (let i = 0; i < 60 && !tools.length; i++) {
  tools = (await client.listTools()).tools;
  if (!tools.length) await new Promise((r) => setTimeout(r, 1000));
}
check('the tools appear once the app is up', tools.length > 30, `${tools.length} tools`);
check('the spoiler flag is explicit', /SPOILERS: asOf "session"/.test(tools.find((t) => t.name === 'data_sql')?.description ?? ''));
check('the instructions name the mods folder', client.getInstructions()?.includes(path.join('.config', 'f1a', 'mods')));

// Finding and opening a race, as an agent would.
const events = await must('catalog_events', { year });
const event = events.find((e) => JSON.stringify(e).includes(eventName));
if (!event) await finish(1);
const race = (await must('catalog_sessions', { pageId: event.pageId, year })).find((s) => s.type === 'race');
await must('session_open', { contentId: race.contentId });
await must('audio_set_volume', { volume: 0 });
let state = null;
for (let i = 0; i < 120; i++) {
  state = await must('state');
  if (state.sessionData.state === 'ready' && state.clock.end > 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('the session is open with data', state.session?.contentId === race.contentId && state.sessionData.state === 'ready');
const [start] = (await must('data_sql', { sql: 'SELECT MIN(date_start) AS t FROM laps WHERE lap_number = ?', params: [lap], asOf: 'session' })).rows;
await must('playback_seek_to_date', { dateMs: start.t });
await must('playback_play');
await new Promise((r) => setTimeout(r, 5000));
state = await must('state');
check(`it's at lap ${lap}`, state.sessionData.lapCount?.current === lap, JSON.stringify(state.sessionData.lapCount));
const atPlayhead = (await must('data_sql', { sql: 'SELECT MAX(lap_number) AS lap FROM laps' })).rows[0].lap;
check('a read without the flag stops at the playhead', atPlayhead <= lap + 1, `latest lap ${atPlayhead}`);

// Building a mod.
mkdirSync(modDir, { recursive: true });
save(source);
let mod = await must('mods_check', { name: NAME });
check('the mod builds and loads', mod.state === 'ready' && mod.version === 1, JSON.stringify(mod).slice(0, 200));
await must('layout_add', { items: [{ type: NAME, props: {} }] });
await new Promise((r) => setTimeout(r, 2500));
let shot = await call('screenshot', { tile: NAME });
check('the tile screenshot is a PNG', shot.image?.mimeType === 'image/png');
if (shot.image) writeFileSync(path.join(outDir, 'mcp-1-tile.png'), Buffer.from(shot.image.data, 'base64'));
const query = shot.value.tiles?.[0]?.queries?.[0];
check('it says what the query returned', query?.state === 'ready' && query.rowCount > 0, `${query?.rowCount} rows`);

// Saved again, and checked at once, before the watcher may have seen it.
save(source.replace('const LAPS = 8;', 'const LAPS = 3;'));
mod = await must('mods_check', { name: NAME });
check('a check right after a save waits for it', mod.state === 'ready' && mod.version === 2, `version ${mod.version}`);
shot = await call('screenshot', {});
if (shot.image) writeFileSync(path.join(outDir, 'mcp-2-window.png'), Buffer.from(shot.image.data, 'base64'));
check('the window screenshot lists both tiles', shot.value.tiles?.length === 2);
state = await must('state');
check('playback carried on', state.clock.playing && state.session?.contentId === race.contentId);

// A broken save fails the check with the compiler's error, and the last good version stays.
save(source.replace('function LapForm() {', 'function LapForm( {'));
const broken = await call('mods_check', { name: NAME });
check('a broken save fails the check', broken.error?.includes('main.tsx:'), broken.error?.split('\\n')[0]);
check('the tile is still on screen', (await must('state')).tiles.some((t) => t.key === NAME));

// Wrong arguments are refused before anything runs.
const wrong = await call('playback_seek', { time: 'soon' });
check('wrong argument types are refused', wrong.error?.startsWith('Invalid arguments'), wrong.error);

rmSync(modDir, { recursive: true, force: true });
for (let i = 0; i < 20 && (await must('state')).tiles.some((t) => t.key === NAME); i++) await new Promise((r) => setTimeout(r, 250));
check('removing the folder takes the tile off', !(await must('state')).tiles.some((t) => t.key === NAME));

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
await must('session_close');
await finish(failures ? 1 : 0);
