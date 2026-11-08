// Plays four streams of a real session and reports whether DRM playback and sync hold up.
// It prints no race data, so it is safe for sessions you haven't watched.
// Usage: node scripts/drm-check.mjs [screenshot-dir]
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './harness.mjs';

const outDir = process.argv[2] ?? tmpdir();
const YEAR = Number(process.env.F1A_YEAR ?? 2026);
const EVENT = new RegExp(process.env.F1A_EVENT ?? 'mexic', 'i');
const DRIVERS = (process.env.F1A_DRIVERS ?? 'HAM,NOR,LEC').split(',');

const { page, stop } = await startApp();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 240));
});

const opened = await page.evaluate(
  async ({ YEAR, EVENT }) => {
    const re = new RegExp(EVENT, 'i');
    const seasons = await window.f1a.f1tv.seasons();
    const season = seasons.find((s) => s.year === YEAR);
    const events = await window.f1a.f1tv.events(season.pageId);
    const event = events.find((e) => re.test(e.name) || re.test(e.shortName));
    const sessions = await window.f1a.f1tv.sessions(event.pageId, YEAR);
    const race = sessions.find((s) => s.type === 'race' && s.series === 'FORMULA 1') ?? sessions.find((s) => s.type === 'race');
    const viewing = await import('/src/host/viewing.ts');
    const channels = await viewing.openViewingSession(race);
    window.modules = {
      viewing,
      session: await import('/src/data/session.ts'),
      timing: await import('/src/data/timing/timingSource.ts'),
      layout: await import('/src/layout/store.ts'),
      video: await import('/src/host/viewing.ts'),
    };
    return {
      seasons: seasons.length,
      events: events.length,
      event: event.shortName,
      sessions: sessions.map((s) => `${s.type}:${s.status}`),
      drm: await window.f1a.f1tv.play(race.contentId).then((p) => ({ streamType: p.streamType, license: !!p.licenseUrl })),
      race: { contentId: race.contentId, title: race.title, meetingKey: race.meetingKey, sessionKey: race.sessionKey },
      channels: channels.map((c) => `${c.label}(${c.kind})`),
    };
  },
  { YEAR, EVENT: EVENT.source },
);
console.log(JSON.stringify(opened, null, 1));

const sample = () =>
  page.evaluate(() => {
    const { useSession } = window.modules.session;
    const state = useSession.getState();
    const videos = [...document.querySelectorAll('video.stream-video')];
    const ref = videos[0];
    return {
      clock: { t: +state.clock.timeSec.toFixed(2), playing: state.clock.playing, buffering: state.clock.buffering, end: Math.round(state.clock.end), wall: !!state.clock.wallClockMs },
      audio: state.channels.find((c) => c.id === state.audioChannelId)?.label ?? null,
      streams: Object.values(state.streams).map((s) => {
        const channel = state.channels.find((c) => c.id === s.channelId);
        const v = videos.find((x) => x.dataset.channel === s.channelId);
        const q = v?.getVideoPlaybackQuality();
        return {
          label: channel?.label,
          status: s.status,
          error: s.error,
          t: v ? +v.currentTime.toFixed(2) : null,
          drift: v && ref ? +(v.currentTime - ref.currentTime).toFixed(3) : null,
          rate: v?.playbackRate,
          ready: v?.readyState,
          frames: q?.totalVideoFrames,
          dropped: q?.droppedVideoFrames,
          size: v ? `${v.videoWidth}x${v.videoHeight}` : null,
          muted: v?.muted,
          encrypted: !!v?.mediaKeys,
        };
      }),
    };
  });

const report = (label, s) => {
  console.log(`--- ${label}: t=${s.clock.t} end=${s.clock.end} playing=${s.clock.playing} buffering=${s.clock.buffering} wallClock=${s.clock.wall} audio=${s.audio}`);
  for (const x of s.streams) console.log(`  ${String(x.label).padEnd(14)} ${x.status.padEnd(9)} t=${x.t} drift=${x.drift} rate=${x.rate} ready=${x.ready} frames=${x.frames} dropped=${x.dropped} ${x.size} muted=${x.muted} encrypted=${x.encrypted}${x.error ? ` ERROR: ${x.error}` : ''}`);
};

await page.waitForTimeout(8000);
report('main alone, 8s', await sample());

await page.evaluate((drivers) => {
  const { useSession } = window.modules.session;
  const { layout } = window.modules.layout;
  const { videoSpec } = window.modules.video;
  const channels = useSession.getState().channels;
  const pick = (code) => channels.find((c) => c.label === code);
  layout.add(videoSpec(pick(drivers[0]).id, drivers[0]));
  layout.group([videoSpec(pick(drivers[1]).id, drivers[1]), videoSpec(pick(drivers[2]).id, drivers[2])]);
}, DRIVERS);
const addedAt = Date.now();
await page.waitForTimeout(3000);
report('just after adding 3', await sample());
await page.screenshot({ path: path.join(outDir, 'drm-loading.png') });
await page.waitForTimeout(12000);
report('15s after adding', await sample());

await page.waitForTimeout(20000);
let s = await sample();
report('35s after adding', s);
const drifts = s.streams.map((x) => Math.abs(x.drift ?? 99));
console.log(`max drift ${Math.max(...drifts)}s, ready ${s.streams.filter((x) => x.status === 'ready').length}/${s.streams.length}, elapsed ${(Date.now() - addedAt) / 1000}s`);
await page.screenshot({ path: path.join(outDir, 'drm-playing.png') });

// Pause holds everything.
await page.evaluate(() => window.modules.session.sessionControl.pause());
await page.waitForTimeout(1500);
const p1 = await sample();
await page.waitForTimeout(1500);
const p2 = await sample();
report('paused', p2);
console.log('stayed paused:', p1.clock.t === p2.clock.t);

await page.evaluate(() => window.modules.session.sessionControl.play());
await page.waitForTimeout(3000);

// Seek moves all streams together. A modest seek, well before the race start.
const seekTo = 120;
await page.evaluate((t) => window.modules.session.sessionControl.seek(t), seekTo);
await page.waitForTimeout(10000);
s = await sample();
report(`10s after seek to ${seekTo}`, s);

// Closing the main feed must not stop the clock.
const beforeClose = s.clock.t;
await page.evaluate(() => {
  const { useSession } = window.modules.session;
  const main = useSession.getState().channels.find((c) => c.kind === 'main');
  window.modules.layout.layout.remove(main.id);
});
await page.waitForTimeout(5000);
s = await sample();
report('5s after closing main', s);
console.log('clock kept running without main:', s.clock.t > beforeClose);

// Timing must line up with the picture. The sync API puts lights out at a known video second, so the
// session clock must be stopped just before it and running just after. Prints no race data.
const sessionStart = await page.evaluate(async ({ m, k }) => (await window.f1a.timing.syncData(m, k))?.sessionStartSec ?? null, { m: opened.race.meetingKey, k: opened.race.sessionKey });
if (sessionStart != null) {
  const clockAt = async (t) => {
    await page.evaluate((x) => window.modules.session.sessionControl.seek(x), t);
    await page.waitForTimeout(3000);
    return page.evaluate(() => {
      const timing = window.modules.timing.useTiming.getState();
      return { running: timing.sessionClock?.extrapolating ?? null, at: +window.modules.session.useSession.getState().clock.timeSec.toFixed(1) };
    });
  };
  const before = await clockAt(sessionStart - 12);
  const after = await clockAt(sessionStart + 10);
  console.log(`lights out at video ${sessionStart}s. clock running at ${before.at}s: ${before.running}; at ${after.at}s: ${after.running}`);
  console.log('timing lines up with video:', before.running === false && after.running === true);
}

const timing = await page.evaluate(() => {
  const t = window.modules.timing.useTiming.getState();
  return { available: t.available, driverRows: t.drivers.length, hasClock: !!t.sessionClock, hasWeather: !!t.weather };
});
console.log('timing:', JSON.stringify(timing));

await stop();
process.exit(0);
