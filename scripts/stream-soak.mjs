// Opens a session and adds three streams, over and over, and reports how long they take to become
// ready. Use it to measure CDN stalls, which come and go. Prints no race data.
// Usage: node scripts/stream-soak.mjs [cycles]
import { startApp } from './harness.mjs';

const cycles = Number(process.argv[2] ?? 8);
const LIMIT_MS = 45_000;
const { page, stop } = await startApp(5194);
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  window.m = {
    viewing: await import('/src/host/viewing.ts'),
    session: await import('/src/data/session.ts'),
    layout: await import('/src/layout/store.ts'),
    video: await import('/src/host/viewing.ts'),
  };
});
const race = await page.evaluate(async () => {
  const season = (await window.f1a.f1tv.seasons()).find((s) => s.year === 2025);
  const event = (await window.f1a.f1tv.events(season.pageId)).find((e) => /mexic/i.test(e.shortName));
  return (await window.f1a.f1tv.sessions(event.pageId, 2025)).find((s) => s.type === 'race' && s.series === 'FORMULA 1');
});
const statuses = () => page.evaluate(() => Object.values(window.m.session.useSession.getState().streams).map((s) => s.status));
const times = [];
let stuck = 0;
for (let i = 0; i < cycles; i += 1) {
  await page.evaluate((r) => window.m.viewing.openViewingSession(r), race);
  while ((await statuses()).join() !== 'ready') await page.waitForTimeout(200);
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const channels = window.m.session.useSession.getState().channels;
    for (const code of ['HAM', 'NOR', 'LEC']) {
      window.m.layout.layout.add(window.m.video.videoSpec(channels.find((c) => c.label === code).id, code));
    }
  });
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < LIMIT_MS) {
    const s = await statuses();
    if (s.length === 4 && s.every((x) => x === 'ready')) {
      done = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  const elapsed = (Date.now() - t0) / 1000;
  const spread = await page.evaluate(() => {
    const t = [...document.querySelectorAll('video.stream-video')].map((v) => v.currentTime);
    return Math.max(...t) - Math.min(...t);
  });
  times.push(elapsed);
  if (!done) stuck += 1;
  console.log(`CYCLE ${i + 1}: ${done ? `all ready in ${elapsed.toFixed(1)}s` : `NOT READY after ${elapsed.toFixed(0)}s: ${(await statuses()).join()}`} spread=${spread.toFixed(3)}s`);
  await page.evaluate(() => window.m.viewing.closeViewingSession());
  await page.waitForTimeout(1000);
}
const sorted = [...times].sort((a, b) => a - b);
console.log(`RESULT ${cycles - stuck}/${cycles} ready, median ${sorted[sorted.length >> 1].toFixed(1)}s, worst ${sorted.at(-1).toFixed(1)}s`);
await stop();
process.exit(0);
