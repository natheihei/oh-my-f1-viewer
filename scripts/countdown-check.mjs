// Asks the agent for a countdown to a named upcoming session, then waits for it to start by itself.
// Meant for a session due soon. Prints no race information.
// Usage: node scripts/countdown-check.mjs "<request>" <contentId> [timeoutMinutes]
import { startApp, typeInPalette } from './harness.mjs';

const [request, contentIdArg, timeoutArg] = process.argv.slice(2);
const contentId = Number(contentIdArg);
const timeoutMs = Number(timeoutArg ?? 90) * 60_000;
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const { page, stop } = await startApp(5190);
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  window.events = [];
  window.f1a.ai.onEvent((e) => window.events.push(e));
  window.m = { session: await import('/src/data/session.ts'), viewing: await import('/src/host/viewing.ts') };
});

await typeInPalette(page, request);
// Anything typed in the palette later would be an agent turn, so attribute any such turn in the log.
await page.exposeFunction('logAgentEvent', (m) => log(`agent activity after the countdown started: ${m}`));
await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 90_000 });
const events = await page.evaluate(() => window.events);
log(`tools: ${events.filter((e) => e.type === 'tool_start').map((e) => `${e.name}${e.name === 'load_session' ? JSON.stringify(e.args) : ''}`).join(' ')}`);
log(`reply: ${events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('')}`);

const countdown = await page.evaluate(() => {
  const c = window.m.viewing.useCountdown.getState().countdown;
  return c && { title: c.title, startMs: c.startMs, contentId: c.session.contentId };
});
log(`countdown: ${JSON.stringify(countdown)}`);
await page.evaluate(() => {
  window.f1a.ai.onEvent((e) => {
    if (e.type === 'turn_start' || e.type === 'tool_start') window.logAgentEvent(`${e.type} ${e.name ?? ''} ${e.args ? JSON.stringify(e.args) : ''}`);
  });
  const input = document.querySelector('[data-testid=palette-input]');
  input?.addEventListener('keydown', (e) => { if (e.isTrusted && e.key === 'Enter') window.logAgentEvent(`real keyboard Enter in the palette: "${input.textContent}"`); }, true);
});
if (countdown?.contentId !== contentId) {
  log(`FAIL expected a countdown for ${contentId}`);
  await stop();
  process.exit(1);
}

const deadline = Date.now() + timeoutMs;
let lastLive = '';
let opened = null;
while (Date.now() < deadline) {
  const state = await page.evaluate(async () => ({
    live: (await window.f1a.f1tv.liveNow().catch(() => [])).map((i) => i.contentId),
    session: window.m.session.useSession.getState().session,
    counting: !!window.m.viewing.useCountdown.getState().countdown,
  }));
  const live = state.live.join(',');
  if (live !== lastLive) {
    log(`F1 TV live list is now: [${live}]`);
    lastLive = live;
  }
  if (state.session) {
    opened = state.session;
    break;
  }
  await page.waitForTimeout(5000);
}
if (!opened) {
  log(`FAIL no session opened within the limit. Live list: [${lastLive}]`);
  await stop();
  process.exit(1);
}
log(`session opened by itself: ${opened.contentId} ${opened.title} status=${opened.status}`);
log(opened.contentId === contentId ? 'ok   it opened the session the countdown was for' : 'FAIL it opened a different session');

const started = Date.now();
let playing = null;
while (Date.now() - started < 60_000 && !playing) {
  playing = await page.evaluate(() => {
    const v = document.querySelector('video.stream-video');
    const s = Object.values(window.m.session.useSession.getState().streams)[0];
    if (!v || s?.status !== 'ready') return null;
    return { encrypted: !!v.mediaKeys, frames: v.getVideoPlaybackQuality().totalVideoFrames, size: `${v.videoWidth}x${v.videoHeight}` };
  });
  if (!playing) await page.waitForTimeout(500);
}
log(playing ? `ok   playing ${JSON.stringify(playing)}` : 'FAIL the stream did not start');
await stop();
process.exit(opened.contentId === contentId && playing ? 0 : 1);
