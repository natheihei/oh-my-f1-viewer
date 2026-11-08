// Run during a live session: opens it through the agent and checks DRM, the live edge, DVR and
// timing. Prints health data only, no race information.
// Usage: node scripts/live-check.mjs [screenshot-dir]
import path from 'node:path';
import { tmpdir } from 'node:os';
import { paletteText, startApp, typeInPalette } from './harness.mjs';

const outDir = process.argv[2] ?? tmpdir();
const { page, stop } = await startApp(5193);
const seen = new Set();
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' || /\[stream\]/.test(t)) && !seen.has(t)) {
    seen.add(t);
    console.log('[console]', t.slice(0, 240));
  }
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

await page.waitForTimeout(2500);
await page.evaluate(async () => {
  window.events = [];
  window.f1a.ai.onEvent((e) => window.events.push(e));
  window.m = {
    session: await import('/src/data/session.ts'),
    timing: await import('/src/data/timing/timingSource.ts'),
    layout: await import('/src/layout/store.ts'),
  };
});

const live = await page.evaluate(() => window.f1a.f1tv.liveNow());
console.log('F1 TV live now:', JSON.stringify(live.map((i) => ({ contentId: i.contentId, title: i.title, meetingKey: i.meetingKey, sessionKey: i.sessionKey }))));
check('F1 TV reports something live', live.length > 0);

async function say(text) {
  console.log(`> ${text}`);
  await page.evaluate(() => { window.events.length = 0; });
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 90_000 });
  const events = await page.evaluate(() => window.events);
  const err = events.find((e) => e.type === 'error');
  if (err) console.log('  ERROR', err.message);
  console.log('  tools:', events.filter((e) => e.type === 'tool_start').map((e) => e.name).join(' ') || 'none');
  console.log('  reply:', events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('').slice(0, 200));
  return events;
}

const sample = () =>
  page.evaluate(() => {
    const s = window.m.session.useSession.getState();
    const c = s.clock;
    const videos = [...document.querySelectorAll('video.stream-video')];
    return {
      session: s.session && { title: s.session.title, status: s.session.status, year: s.session.year, meetingKey: s.session.meetingKey, sessionKey: s.session.sessionKey },
      clock: { t: +c.timeSec.toFixed(1), playing: c.playing, buffering: c.buffering, live: c.live, start: Math.round(c.start), end: Math.round(c.end), behind: +(c.end - c.timeSec).toFixed(1), atEdge: c.atLiveEdge, wall: c.wallClockMs, lagSec: c.wallClockMs ? +((Date.now() - c.wallClockMs) / 1000).toFixed(1) : null },
      streams: Object.values(s.streams).map((v) => {
        const label = s.channels.find((x) => x.id === v.channelId)?.label;
        const el = videos.find((x) => x.dataset.channel === v.channelId);
        const q = el?.getVideoPlaybackQuality();
        return { label, status: v.status, error: v.error, t: el ? +el.currentTime.toFixed(2) : null, encrypted: !!el?.mediaKeys, ready: el?.readyState, frames: q?.totalVideoFrames, dropped: q?.droppedVideoFrames, size: el ? `${el.videoWidth}x${el.videoHeight}` : null, rate: el?.playbackRate };
      }),
    };
  });

const show = (label, s) => {
  console.log(`--- ${label}: ${JSON.stringify(s.clock)}`);
  const t0 = s.streams[0]?.t ?? 0;
  for (const x of s.streams) console.log(`  ${String(x.label).padEnd(14)} ${x.status.padEnd(9)} drift=${x.t != null ? (x.t - t0).toFixed(3) : '-'} encrypted=${x.encrypted} ready=${x.ready} frames=${x.frames} dropped=${x.dropped} ${x.size} rate=${x.rate}${x.error ? ` ERROR: ${x.error}` : ''}`);
};

const untilReady = async (limit = 60_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    const s = await sample();
    if (s.streams.length && s.streams.every((x) => x.status === 'ready')) return (Date.now() - t0) / 1000;
    await page.waitForTimeout(500);
  }
  return null;
};

await say('Open the race that is live now.');
let s = await sample();
console.log('session:', JSON.stringify(s.session));
check('agent opened a live session', s.session?.status === 'live');
if (!s.session) {
  console.log(await paletteText(page));
  await stop();
  process.exit(1);
}

const mainReady = await untilReady();
s = await sample();
show(`main, ready after ${mainReady}s`, s);
check('main live stream plays', mainReady != null);
check('main stream uses DRM', s.streams[0]?.encrypted === true);
check('joined at the live offset, not on top of the edge', s.clock.behind >= 5 && s.clock.behind < 15, `${s.clock.behind}s behind`);
await page.waitForTimeout(5000);
const later = await sample();
check('live position advances', later.clock.t > s.clock.t + 3, `${s.clock.t} -> ${later.clock.t}`);
check('frames are being decoded', later.streams[0].frames > s.streams[0].frames);
await page.screenshot({ path: path.join(outDir, 'live-main.png') });

await say('Hamilton. Also battle between Norris and Leclerc.');
const allReady = await untilReady(75_000);
s = await sample();
show(`four streams, ready after ${allReady}s`, s);
check('all four live streams ready', allReady != null);
check('every stream uses DRM', s.streams.every((x) => x.encrypted), s.streams.map((x) => `${x.label}:${x.encrypted}`).join(' '));

await page.waitForTimeout(15000);
s = await sample();
show('15s later', s);
const times = s.streams.map((x) => x.t);
const spread = Math.max(...times) - Math.min(...times);
check('live streams stay in sync', spread < 0.5, `spread ${spread.toFixed(3)}s`);
check('all still ready', s.streams.every((x) => x.status === 'ready'), s.streams.map((x) => x.status).join());
await page.screenshot({ path: path.join(outDir, 'live-four.png') });

// DVR
const before = s.clock;
const rowsBefore = await page.evaluate(() => window.m.timing.useTiming.getState().heldRecords);
await page.evaluate((t) => window.m.session.sessionControl.seek(t), before.t - 180);
await page.waitForTimeout(12000);
const heldAfterRewind = await page.evaluate(() => window.m.timing.useTiming.getState().heldRecords);
console.log(`timing records held: ${rowsBefore} at the edge, ${heldAfterRewind} after rewinding`);
s = await sample();
show('12s after seeking back 3 minutes', s);
check('DVR seek landed', Math.abs(s.clock.t - (before.t - 180 + 12)) < 8, `wanted about ${(before.t - 168).toFixed(1)}, at ${s.clock.t}`);
check('no longer at the live edge', !s.clock.atEdge, `${s.clock.behind}s behind`);
const dvrTimes = s.streams.map((x) => x.t);
check('streams followed the DVR seek', Math.max(...dvrTimes) - Math.min(...dvrTimes) < 0.7, `spread ${(Math.max(...dvrTimes) - Math.min(...dvrTimes)).toFixed(3)}s`);

// Back to live
await page.evaluate(() => window.m.session.sessionControl.goLive());
await page.waitForTimeout(12000);
s = await sample();
show('12s after go live', s);
check('returns to the live edge', s.clock.atEdge, `${s.clock.behind}s behind`);
const liveTimes = s.streams.map((x) => x.t);
check('streams followed back to live', Math.max(...liveTimes) - Math.min(...liveTimes) < 0.7, `spread ${(Math.max(...liveTimes) - Math.min(...liveTimes)).toFixed(3)}s`);

// Pause, then resume
await page.evaluate(() => window.m.session.sessionControl.pause());
await page.waitForTimeout(4000);
const p1 = await sample();
await page.evaluate(() => window.m.session.sessionControl.play());
await page.waitForTimeout(8000);
s = await sample();
check('pause holds, then resume plays on', s.clock.t > p1.clock.t + 4 && s.streams.every((x) => x.status === 'ready'), `${p1.clock.t} -> ${s.clock.t}`);

// Timing, buffered to the video. Reports shape only.
const timing = await page.evaluate(() => {
  const t = window.m.timing.useTiming.getState();
  return { available: t.available, driverRows: t.drivers.length, hasClock: !!t.sessionClock, hasWeather: !!t.weather, hasLapCount: !!t.lapCount, hasTrackStatus: !!t.trackStatus };
});
console.log('timing:', JSON.stringify(timing));
check('live timing reaches the app', timing.available && timing.driverRows > 0);

// How far timing is held back relative to arrival, measured around a burst of live records.
const delay = await page.evaluate(async () => {
  const arrivals = [];
  const off = window.f1a.timing.onLiveUpdate(() => arrivals.push(Date.now()));
  let versionChanges = 0;
  let last = null;
  const unsub = window.m.timing.useTiming.subscribe((st) => { if (st !== last) { versionChanges += 1; last = st; } });
  await new Promise((r) => setTimeout(r, 8000));
  off();
  unsub();
  const c = window.m.session.useSession.getState().clock;
  return { recordsIn8s: arrivals.length, publishesIn8s: versionChanges, videoLagSec: c.wallClockMs ? +((Date.now() - c.wallClockMs) / 1000).toFixed(1) : null };
});
console.log('live feed:', JSON.stringify(delay));
const held = await page.evaluate(() => window.m.timing.useTiming.getState().heldRecords);
const expected = (delay.recordsIn8s / 8) * (delay.videoLagSec ?? 0);
check('timing is held back until the video reaches it', held > expected * 0.3, `${held} records held; about ${Math.round(expected)} expected for ${delay.videoLagSec}s of lag`);
check('live feed is flowing', delay.recordsIn8s > 0, `${delay.recordsIn8s} records in 8s`);

// F1 TV's schedule has to keep working during a live session.
const upcoming = await say('What sessions are coming up?');
check('upcoming sessions are listed during a live session', upcoming.some((e) => e.type === 'tool_start' && e.name === 'list_upcoming') && !upcoming.some((e) => e.type === 'tool_end' && !e.ok));

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await stop();
process.exit(failures ? 1 : 0);
