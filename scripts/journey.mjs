// The product's success journey, run for real: the actual agent, F1 TV and video. Needs both sign-ins.
// Usage: node scripts/journey.mjs [screenshot-dir]
import path from 'node:path';
import { tmpdir } from 'node:os';
import { paletteText, startApp, typeInPalette } from './harness.mjs';

const outDir = process.argv[2] ?? tmpdir();
const { page, stop } = await startApp();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 220));
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

await page.waitForTimeout(2000);
await page.evaluate(async () => {
  window.events = [];
  window.omfv.ai.onEvent((e) => window.events.push({ ...e, at: performance.now() }));
  window.m = { session: await import('/src/data/session.ts'), layout: await import('/src/layout/store.ts') };
});

/** Sends a message, waits for the agent to finish, and reports what it did. */
async function say(text, shot) {
  console.log(`\n> ${text}`);
  const start = await page.evaluate(() => {
    window.events.length = 0;
    return performance.now();
  });
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 90_000 });
  const events = await page.evaluate(() => window.events);
  const end = events.find((e) => e.type === 'turn_end' || e.type === 'error');
  const firstTool = events.find((e) => e.type === 'tool_start');
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  if (end.type === 'error') console.log(`  ERROR: ${end.message}`);
  const tools = events.filter((e) => e.type === 'tool_start').map((e) => `${e.name}(${JSON.stringify(e.args)})`);
  const failedTools = events.filter((e) => e.type === 'tool_end' && !e.ok).map((e) => e.name);
  console.log(`  tools: ${tools.join(' ') || 'none'}`);
  if (failedTools.length) console.log(`  failed tools: ${failedTools.join(' ')}`);
  console.log(`  reply: ${reply}`);
  console.log(`  time: first tool ${firstTool ? Math.round(firstTool.at - start) : '-'}ms, total ${Math.round(end.at - start)}ms`);
  if (shot) await page.screenshot({ path: path.join(outDir, shot) });
  return { reply, tools: events.filter((e) => e.type === 'tool_start').map((e) => e.name), failed: failedTools, ok: end.type !== 'error' };
}

const state = () =>
  page.evaluate(() => {
    const s = window.m.session.useSession.getState();
    const l = window.m.layout.layout.snapshot();
    return {
      session: s.session?.title ?? null,
      contentId: s.session?.contentId ?? null,
      tiles: l.tiles.map((t) => t.component.label),
      statuses: Object.values(s.streams).map((v) => `${s.channels.find((c) => c.id === v.feed)?.label}:${v.status}`),
      audio: s.channels.find((c) => c.id === s.streams[s.audioVideoId]?.feed)?.label ?? null,
      playing: s.clock.playing,
      t: s.clock.timeSec,
    };
  });

const allReady = async (timeoutMs = 75_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await state();
    if (s.statuses.length && s.statuses.every((x) => x.endsWith(':ready'))) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

const paletteVisible = () => page.locator('[data-testid=palette]').isVisible();

console.log('palette on launch:', JSON.stringify(await paletteText(page)));
check('blank page shows the palette', await paletteVisible());
check('reports ready when both are signed in', /Ready/.test(await paletteText(page)));

// A weekend that hasn't finished needs clarifying. Name the next one, so this works any time.
const nextEvent = await page.evaluate(async () => {
  const main = (await window.omfv.f1tv.upcoming()).find((x) => x.series === 'FORMULA 1' && ['practice', 'qualifying', 'race'].includes(x.type));
  return main?.title.match(/^(\d{4}) (.+?) (?:GP|Grand Prix)/)?.slice(1, 3).join(' ') ?? null;
});
let r = await say(nextEvent ?? '2026 Brazil', 'journey-1-clarify.png');
let s = await state();
check('clarifies instead of acting', s.session == null && !r.tools.includes('load_session') && r.reply.includes('?'), r.reply.slice(0, 120));
check('palette stays open while asking', await paletteVisible());

// Naming the session is clear. A bare event could mean any of its sessions, so the pick agent asks.
r = await say('2025 Mexico race');
s = await state();
check('loads the session', r.tools.includes('load_session') && /2025.*Mexico/i.test(s.session ?? ''), s.session ?? 'none');
check('starts with just the main broadcast', s.tiles.length === 1, JSON.stringify(s.tiles));
check('main broadcast plays', await allReady(), JSON.stringify((await state()).statuses));
await page.screenshot({ path: path.join(outDir, 'journey-2-main.png') });

// The palette gets out of the way after acting.
await page.waitForTimeout(2600);
check('palette hides after acting', !(await paletteVisible()));

// Multiple requests in a message.
r = await say('Hamilton. Also battle between Noris and Lec.');
s = await state();
check('no tool call failed, even with the misspellings', !r.failed.length, r.failed.join());
check('adds Hamilton as a tile', s.tiles.includes('HAM'), JSON.stringify(s.tiles));
check('adds Norris and Leclerc', s.tiles.includes('NOR') && s.tiles.includes('LEC'), JSON.stringify(s.tiles));
check('all streams become ready', await allReady(), JSON.stringify((await state()).statuses));
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(outDir, 'journey-3-battle.png') });
const drift = await page.evaluate(() => {
  const v = [...document.querySelectorAll('video.stream-video')];
  const times = v.map((x) => x.currentTime);
  return Math.max(...times) - Math.min(...times);
});
check('streams are in sync', drift < 0.2, `spread ${drift.toFixed(3)}s`);

// Closing the battle leaves the rest alone.
const hamBefore = await page.evaluate(() => {
  const v = document.querySelector('video.stream-video[data-channel$=":1007"]') ?? [...document.querySelectorAll('video.stream-video')][1];
  v.dataset.marker = 'kept';
  return v.dataset.channel;
});
r = await say('Done with Nor, Lec battle.');
s = await state();
check('closes the battle', !s.tiles.includes('NOR') && !s.tiles.includes('LEC'), JSON.stringify(s.tiles));
check('keeps the main feed and Hamilton', s.tiles.length === 2 && s.tiles.includes('HAM'), JSON.stringify(s.tiles));
check('Hamilton kept the same video element', await page.evaluate((id) => document.querySelector(`video[data-channel="${id}"]`)?.dataset.marker === 'kept', hamBefore));
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, 'journey-4-closed.png') });

// Beyond the core journey.
const tBefore = (await state()).t;
r = await say('pause');
s = await state();
check('pause stops playback', s.playing === false);
r = await say('audio on Hamilton');
s = await state();
check('audio moves to Hamilton', s.audio === 'HAM', s.audio ?? 'none');
r = await say('skip ahead ten minutes');
s = await state();
check('skips ahead through seek_to', r.tools.includes('seek_to') && Math.abs(s.t - tBefore - 600) < 30, `${Math.round(s.t - tBefore)}s`);
r = await say('go back 30 seconds');
check('can rewind', r.tools.includes('seek_to') && Math.abs((await state()).t - s.t + 30) < 10);
r = await say('resume');
check('resume runs', (await state()).playing === true);

// Spoiler probe: it must not answer from memory.
r = await say('who won this race?');
check('does not name a winner', !/\b(verstappen|norris|leclerc|hamilton|piastri|russell|won by|winner was)\b/i.test(r.reply), r.reply.slice(0, 120));

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
console.log('palette at end:\n' + (await paletteText(page)));
await stop();
process.exit(failures ? 1 : 0);
