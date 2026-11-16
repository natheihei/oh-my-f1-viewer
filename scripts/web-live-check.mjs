// Run during a live session: the browser build's version of scripts/live-check.mjs. Opens what's on air in a
// Chrome of its own and checks protected live video, the live offset, sync across streams, DVR and the live
// timing capture. Driven through the host, so it needs only the F1 TV sign-in. Prints health data only, no
// race information. Needs `npm run build:web`.
// Usage: node scripts/web-live-check.mjs <screenshot-dir> [--simulate]
//   --simulate runs it with nothing on air: F1 TV's answers for one made-up live session are replaced in the
//   page, and its feeds are DASH-IF's public live test stream, which isn't protected. Everything after those
//   answers is the app's own: the live offset, sync, DVR, the return to the edge, and the timing capture
//   from F1's real feed. It doesn't show that F1's live streams and their licenses work.
import path from 'node:path';
import { signInFromMainProfile, startWebApp } from './web.mjs';

const outDir = process.argv[2];
const simulate = process.argv.includes('--simulate');
const TEST_STREAM = 'https://livesim2.dashif.org/livesim2/tsbd_600/testpic_2s/Manifest.mpd';
if (!outDir || outDir.startsWith('--')) throw new Error('Usage: node scripts/web-live-check.mjs <screenshot-dir>');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await startWebApp(outDir, { name: 'web-live-check' });
const page = await app.open();
const done = async (code) => {
  await app.stop();
  process.exit(code);
};
process.on('uncaughtException', async (e) => {
  console.log('FAIL', e.message);
  await done(1);
});

if (!(await signInFromMainProfile(app.context, page))) {
  console.log('FAIL F1 TV is not signed in');
  await done(1);
}
if (simulate) {
  await page.evaluate(async (manifestUrl) => {
    const contentId = 1999999999;
    const title = 'Simulated live session';
    const feeds = ['F1 LIVE', 'ONE', 'TWO', 'THREE'].map((label, i) => ({ id: `${contentId}:${i}`, contentId, ...(i ? { channelId: i } : {}), kind: i ? 'onboard' : 'main', label, title: label }));
    const f1tv = window.f1a.f1tv;
    f1tv.liveNow = async () => [{ contentId, title }];
    f1tv.sessions = async () => [{ contentId, title, type: 'practice', year: new Date().getUTCFullYear(), startMs: Date.now() - 600_000, endMs: null, meetingKey: null, sessionKey: null, hasOnboards: true, series: 'FORMULA 1', status: 'live' }];
    f1tv.channels = async () => feeds;
    f1tv.play = async (_contentId, channelId) => ({ manifestUrl, licenseUrl: '', contentId, channelId });
    // The catalog learns of a session from an event's list.
    await window.host.catalog.sessions({ pageId: 1 });
  }, TEST_STREAM);
}
const live = await page.evaluate(() => window.f1a.f1tv.liveNow());
console.log('F1 TV live now:', JSON.stringify(live.map((i) => ({ contentId: i.contentId, title: i.title, meetingKey: i.meetingKey, sessionKey: i.sessionKey }))));
check('F1 TV reports something live', live.length > 0);
if (!live.length) {
  console.log('Nothing is on air: run this during a session.');
  await done(1);
}

await page.evaluate(async (item) => {
  window.lastStatus = null;
  window.f1a.data.onStatus((s) => (window.lastStatus = s));
  window.host.audio.setVolume({ volume: 0 });
  await window.host.session.open({ contentId: item.contentId, title: item.title });
}, live[0]);

const sample = () =>
  page.evaluate(() => {
    const { clock, streams } = window.read();
    const videos = [...document.querySelectorAll('video')];
    return {
      clock: { t: +clock.timeSec.toFixed(1), live: clock.live, end: Math.round(clock.end), behind: +(clock.end - clock.timeSec).toFixed(1), atEdge: clock.atLiveEdge },
      streams: Object.values(streams).map((s) => s.status),
      videos: videos.map((v) => ({ t: +v.currentTime.toFixed(2), encrypted: !!v.mediaKeys, frames: v.getVideoPlaybackQuality().totalVideoFrames })),
    };
  });
const untilReady = async (count, limit) => {
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    const s = await sample();
    if (s.streams.length >= count && s.streams.every((x) => x === 'ready')) return (Date.now() - t0) / 1000;
    await sleep(500);
  }
  return null;
};

const mainReady = await untilReady(1, 90_000);
let s = await sample();
console.log(`--- main, ready after ${mainReady}s: ${JSON.stringify(s.clock)}`);
check('the session is live', s.clock.live === true);
check('the main live stream plays', mainReady != null);
if (!simulate) check('it uses DRM', s.videos[0]?.encrypted === true);
check('it joined at the live offset, not on top of the edge', s.clock.behind >= 5 && s.clock.behind < 15, `${s.clock.behind}s behind`);
await sleep(5000);
const later = await sample();
check('the live position advances', later.clock.t > s.clock.t + 3, `${s.clock.t} -> ${later.clock.t}`);
check('frames are being decoded', later.videos[0]?.frames > s.videos[0]?.frames);
await page.screenshot({ path: path.join(outDir, 'live-main.png') }).catch(() => {});

const added = await page.evaluate(async () => {
  const onboards = window.read().feeds.filter((f) => f.kind === 'onboard').slice(0, 3);
  if (onboards.length) await window.host.layout.add({ items: onboards.map((f) => ({ type: 'video', props: { feed: f.id } })) });
  return onboards.length;
});
if (added) {
  const allReady = await untilReady(1 + added, 90_000);
  check(`${1 + added} live streams are ready`, allReady != null, `${allReady}s`);
  await sleep(15_000);
  s = await sample();
  const times = s.videos.map((v) => v.t).filter((t) => t > 0);
  check('they stay in sync', Math.max(...times) - Math.min(...times) < 0.5, `spread ${(Math.max(...times) - Math.min(...times)).toFixed(3)}s`);
  if (!simulate) check('every stream uses DRM', s.videos.every((v) => v.encrypted));
  await page.screenshot({ path: path.join(outDir, 'live-streams.png') }).catch(() => {});
} else {
  console.log('(no onboards in this session: one stream only)');
}

const status = await page.evaluate(() => window.lastStatus && { state: window.lastStatus.state, source: window.lastStatus.coverage?.source, gaps: window.lastStatus.coverage?.gaps?.length });
check('timing is captured from the live feed', status?.state === 'ready' && status.source === 'live', JSON.stringify(status));
const rows = () => page.evaluate(async () => (await window.host.data.sql({ sql: 'SELECT COUNT(*) AS n FROM position' })).rows[0].n);
const before = (await sample()).clock;
const rowsAtEdge = await rows();
await page.evaluate((time) => window.host.playback.seek({ time }), before.t - 180);
await sleep(12_000);
s = await sample();
const rowsRewound = await rows();
console.log(`position rows visible: ${rowsAtEdge} at the edge, ${rowsRewound} after rewinding`);
check('rewinding hides what the video has not reached', rowsRewound <= rowsAtEdge);
check('the DVR seek landed', Math.abs(s.clock.t - (before.t - 180 + 12)) < 8, `wanted about ${(before.t - 168).toFixed(1)}, at ${s.clock.t}`);
check('it is no longer at the live edge', !s.clock.atEdge, `${s.clock.behind}s behind`);
await page.evaluate(() => window.host.playback.goLive());
await sleep(10_000);
s = await sample();
check('it returns to the live edge', s.clock.behind < 15, `${s.clock.behind}s behind`);
await page.screenshot({ path: path.join(outDir, 'live-after-dvr.png') }).catch(() => {});

console.log(failures ? `${failures} FAILED` : 'all passed');
await done(failures ? 1 : 0);
