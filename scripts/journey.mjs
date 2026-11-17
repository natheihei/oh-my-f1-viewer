// The product's success journey, run for real: the actual agent, F1 TV and video. Needs both sign-ins.
// The agent only suggests tiles, so the journey adds what it suggests from the strip, as a viewer would. It
// answers the spoiler check like seek-check does: Allow once while watching, Don't allow when asking who won.
// Prints the agent's replies, which can give the race away: use a session you've watched.
// Usage: node scripts/journey.mjs [screenshot-dir]
import path from 'node:path';
import { tmpdir } from 'node:os';
import { paletteText, startApp, typeInPalette } from './harness.mjs';

const outDir = process.argv[2] ?? tmpdir();
const { page, stop } = await startApp();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 220));
});
process.on('uncaughtException', async (e) => {
  console.log('FAIL', e.message);
  await stop();
  process.exit(1);
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

await page.waitForTimeout(2000);
await page.evaluate(async () => {
  const { host, read } = await import('/src/host/index.ts');
  window.events = [];
  window.omfv.ai.onEvent((e) => window.events.push({ ...e, at: performance.now() }));
  Object.assign(window, { host, read });
});

/** Answers each spoiler check with whatever `answer` holds when it shows, and counts them. */
let answer = 'once';
let asked = 0;
let answering = false;
const answerer = setInterval(async () => {
  if (answering) return;
  answering = true;
  try {
    const button = await page.$(`[data-testid="spoiler-${answer}"]`);
    if (button) {
      asked += 1;
      console.log(`  spoiler check: ${answer}`);
      await button.click();
    }
  } catch {
    // The check closed between finding the button and clicking it.
  } finally {
    answering = false;
  }
}, 250);

/** Sends a message, waits for the agent to finish, and reports what it did. */
async function say(text, shot) {
  console.log(`\n> ${text}`);
  const start = await page.evaluate(() => {
    window.events.length = 0;
    return performance.now();
  });
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 180_000 });
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
  // Let a seek or an added stream settle.
  await page.waitForTimeout(1500);
  if (shot) await page.screenshot({ path: path.join(outDir, shot) });
  return { reply, tools: events.filter((e) => e.type === 'tool_start').map((e) => e.name), failed: failedTools, ok: end.type !== 'error' };
}

/** What's on screen: the session, each tile's label, each video's feed and status, which one is heard, and the clock. */
const state = () =>
  page.evaluate(() => {
    const live = window.read();
    const feedLabel = (feed) => live.feeds.find((c) => c.id === feed)?.label ?? feed;
    const videos = Object.values(live.streams);
    return {
      session: live.session?.title ?? null,
      tiles: live.layout.tiles.map((t) => t.component.label),
      statuses: videos.map((v) => `${feedLabel(v.feed)}:${v.status}`),
      audio: live.audio == null ? null : feedLabel(live.streams[live.audio]?.feed),
      playing: live.clock.playing,
      t: live.clock.timeSec,
      strip: live.suggestions.items.map((i) => ({ key: i.key, label: i.label })),
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
/** Whether a tile's label names a driver, as an onboard's ("HAM") or a chart's ("Gap NOR LEC") does. */
const names = (tiles, code) => tiles.some((label) => label.split(/\s+/).includes(code));

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

// The palette gets out of the way after acting: see AUTO_HIDE_MS in src/shell/agentFeed.ts.
const hidden = await page.waitForFunction(() => !document.querySelector('[data-testid=palette]')?.checkVisibility(), null, { timeout: 15_000 }).then(() => true, () => false);
check('palette hides after acting', hidden);

// Multiple requests in a message. The agent suggests; the viewer adds everything it suggested.
r = await say('Hamilton. Also battle between Noris and Lec.');
s = await state();
const suggested = s.strip.map((i) => i.label);
check('no tool call failed, even with the misspellings', !r.failed.length, r.failed.join());
check('suggests rather than adding', r.tools.includes('suggest_tiles') && s.tiles.length === 1, JSON.stringify(suggested));
check('suggests Hamilton', names(suggested, 'HAM'), JSON.stringify(suggested));
check('suggests Norris and Leclerc', names(suggested, 'NOR') && names(suggested, 'LEC'), JSON.stringify(suggested));
await page.screenshot({ path: path.join(outDir, 'journey-3-suggested.png') });
for (const { key } of s.strip) {
  await page.locator(`[data-testid=suggestion][data-key="${key}"]`).click();
  await page.waitForTimeout(300);
}
s = await state();
check('adds Hamilton as a tile', s.tiles.includes('HAM'), JSON.stringify(s.tiles));
check('adds Norris and Leclerc', names(s.tiles, 'NOR') && names(s.tiles, 'LEC'), JSON.stringify(s.tiles));
check('all streams become ready', await allReady(), JSON.stringify((await state()).statuses));
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(outDir, 'journey-4-battle.png') });
const drift = await page.evaluate(() => {
  const times = [...document.querySelectorAll('[data-testid=video] video')].map((x) => x.currentTime);
  return times.length > 1 ? Math.max(...times) - Math.min(...times) : null;
});
check('streams are in sync', drift != null && drift < 0.2, `spread ${drift?.toFixed(3)}s`);

// Closing the battle leaves the rest alone.
const hamFeed = await page.evaluate(() => window.read().feeds.find((c) => c.label === 'HAM')?.id ?? null);
const marked = await page.evaluate((feed) => {
  const v = document.querySelector(`[data-testid=video][data-feed="${feed}"] video`);
  if (v) v.dataset.marker = 'kept';
  return v != null;
}, hamFeed);
r = await say('Done with Nor, Lec battle.');
s = await state();
check('closes the battle', !names(s.tiles, 'NOR') && !names(s.tiles, 'LEC'), JSON.stringify(s.tiles));
check('keeps the main feed and Hamilton', s.tiles.length === 2 && s.tiles.includes('HAM'), JSON.stringify(s.tiles));
check('Hamilton kept the same video element', marked && (await page.evaluate((feed) => document.querySelector(`[data-testid=video][data-feed="${feed}"] video`)?.dataset.marker === 'kept', hamFeed)));
await page.screenshot({ path: path.join(outDir, 'journey-5-closed.png') });

// Beyond the core journey.
r = await say('pause');
s = await state();
check('pause stops playback', s.playing === false);
const tBefore = s.t;
r = await say('audio on Hamilton');
s = await state();
check('audio moves to Hamilton', s.audio === 'HAM', s.audio ?? 'none');
r = await say('skip ahead ten minutes');
s = await state();
check('skips ahead through seek_to', r.tools.includes('seek_to') && Math.abs(s.t - tBefore - 600) < 30, `${Math.round(s.t - tBefore)}s`);
r = await say('go back 30 seconds');
check('can rewind', r.tools.includes('seek_to') && Math.abs((await state()).t - s.t + 30) < 10, `${Math.round((await state()).t - s.t)}s`);
r = await say('resume');
check('resume runs', (await state()).playing === true);

// Spoiler probe: refused a look ahead, it must not answer from memory either.
answer = 'no';
asked = 0;
r = await say('who won this race?');
check('does not name a winner', !/\b(verstappen|norris|leclerc|hamilton|piastri|russell|won by|winner was)\b/i.test(r.reply), r.reply.slice(0, 120));
console.log(`  (it asked to look ahead ${asked} time(s))`);

clearInterval(answerer);
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
console.log('palette at end:\n' + (await paletteText(page)));
await stop();
process.exit(failures ? 1 : 0);
