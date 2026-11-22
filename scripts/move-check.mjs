// Asks the real agent to move playback by an amount of time, and checks it used seek_to's delta and where playback
// landed. On a live session when there is one, where going back passes the start of the capture and the timing data
// waits; otherwise on a replay race. Needs both sign-ins. Prints tool calls and replies, with no race information asked for.
// Usage: node scripts/move-check.mjs
//   OMFV_YEAR and OMFV_EVENT pick the replay race (2025, mexic).
import { startApp, typeInPalette } from './harness.mjs';

const YEAR = Number(process.env.OMFV_YEAR ?? 2025);
const EVENT = process.env.OMFV_EVENT ?? 'mexic';

const { page, stop } = await startApp(5189);
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
const opened = await page.evaluate(
  async ({ YEAR, EVENT }) => {
    const { host, read } = await import('/src/host/index.ts');
    window.events = [];
    window.omfv.ai.onEvent((e) => window.events.push(e));
    Object.assign(window, { host, read });
    host.audio.setVolume({ volume: 0 });
    const [live] = await window.omfv.f1tv.liveNow();
    if (live) {
      await host.session.open({ contentId: live.contentId, title: live.title });
      return { title: live.title, live: true };
    }
    const re = new RegExp(EVENT, 'i');
    const event = (await host.catalog.events({ year: YEAR })).find((e) => re.test(e.name) || re.test(e.shortName));
    const race = event && (await host.catalog.sessions({ pageId: event.pageId, year: YEAR })).find((s) => s.type === 'race');
    if (!race) return null;
    await host.session.open({ contentId: race.contentId, title: race.title });
    return { title: race.title, live: false };
  },
  { YEAR, EVENT },
);
if (!opened) throw new Error(`Nothing live, and no race found for ${YEAR} ${EVENT}.`);
console.log(`opened: ${opened.title} (${opened.live ? 'live' : 'replay'})`);

await page.waitForFunction(() => window.read().clock.end > 0 && Object.values(window.read().streams).some((s) => s.status === 'ready'), null, { timeout: 120_000 });
// A replay starts at 0: give it room to go back.
if (!opened.live) {
  await page.evaluate(() => window.host.playback.seek({ time: 1200 }));
  await page.waitForTimeout(8000);
}
await page.evaluate(() => window.host.playback.pause());
await page.waitForTimeout(1500);

const where = () => page.evaluate(() => ({ t: window.read().clock.timeSec, data: window.read().sessionData.state }));

let answer = 'once';
const answerer = setInterval(async () => {
  try {
    const button = await page.$(`[data-testid="spoiler-${answer}"]`);
    if (button) {
      console.log(`  spoiler check: ${answer}`);
      await button.click();
    }
  } catch {}
}, 300);

async function say(text) {
  console.log(`\n> ${text}`);
  await page.evaluate(() => { window.events.length = 0; });
  const before = await where();
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 180_000 });
  const events = await page.evaluate(() => window.events);
  const calls = events.filter((e) => e.type === 'tool_start');
  const ends = events.filter((e) => e.type === 'tool_end');
  for (const [i, call] of calls.entries()) console.log(`  tool: ${call.name}(${JSON.stringify(call.args)})${ends[i]?.ok === false ? ' FAILED' : ''}`);
  console.log(`  reply: ${events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('')}`);
  await page.waitForTimeout(2500);
  const after = await where();
  console.log(`  moved ${(after.t - before.t).toFixed(1)}s, data ${before.data} -> ${after.data}`);
  return { calls, moved: after.t - before.t, seek: calls.findLast((c) => c.name === 'seek_to')?.args ?? null, before, after };
}

/** The move was one seek_to by delta alone, with no query before it, and playback moved by that much. */
const movedBy = (name, r, seconds) => {
  check(`${name}: seek_to with delta alone`, r.seek != null && r.seek.date == null && r.seek.delta === seconds, JSON.stringify(r.seek));
  check(`${name}: no query first`, !r.calls.some((c) => c.name === 'query_session'), r.calls.map((c) => c.name).join(' '));
  check(`${name}: playback moved`, Math.abs(r.moved - seconds) < 4, `${r.moved.toFixed(1)}s`);
};

let r = await say('Go back 2 minutes.');
movedBy('back 2 minutes', r, -120);

// On a live session that is now before the capture, where the data waits and app_state has no playhead.
r = await say('Back another minute.');
movedBy(`back again, with the data ${r.before.data}`, r, -60);

r = await say('Skip ahead 30 seconds.');
movedBy('ahead 30 seconds, after Allow once', r, 30);

answer = 'no';
r = await say('Jump forward 5 minutes.');
check("refused forward: playback stays", Math.abs(r.moved) < 4, `${r.moved.toFixed(1)}s`);
answer = 'once';

// A delta on a date: the moment comes from a row, and the offset is the tool's. That needs the data at the frame on
// screen, which a live session only has once the video is back within the capture.
if (opened.live) await page.evaluate(() => { window.host.playback.goLive(); window.host.playback.play(); });
await page.waitForFunction(() => window.read().sessionData.state === 'ready' && window.read().sessionData.playheadMs != null, null, { timeout: 150_000 });
await page.waitForTimeout(opened.live ? 20_000 : 0);
await page.evaluate(() => window.host.playback.pause());

r = await say('Go to 20 seconds before the most recent race control message.');
check('a date with a delta', r.seek != null && r.seek.date != null && r.seek.delta === -20, JSON.stringify(r.seek));

clearInterval(answerer);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await stop();
process.exit(failures ? 1 : 0);
