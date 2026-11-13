// Shows the real app at a range of window sizes, over a real replay race with a typical layout (the main
// feed, two onboards, the timing tower and a chart, with suggestions in the strip), and saves screenshots
// of each size with the palette idle, with the `/` menu open, and with the agent settings open. Measures
// what breaks at each size: `/` rows that wrap, tile titles and strip labels cut off, and the smallest
// tile. Also prints the window's minimum size. Needs the F1 TV sign-in.
// Usage: node scripts/window-size-check.mjs <screenshot-dir> [sizes, such as 1400x860,1024x700] [sessionKey] [year]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startApp } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/window-size-check.mjs <screenshot-dir> [sizes] [sessionKey] [year]');
const sizes = String(process.argv[3] ?? '1400x860,1280x800,1100x720,1024x700,960x640,800x560,640x480')
  .split(',')
  .map((s) => s.split('x').map(Number));
const [sessionKey, year] = [String(process.argv[4] ?? 11396), Number(process.argv[5] ?? 2026)];
mkdirSync(outDir, { recursive: true });

const { app, page, stop } = await startApp(5192);
const fail = async (message) => {
  console.log('FAIL', message);
  await stop();
  process.exit(1);
};

const signedIn = await page.evaluate(async () => (await (await import('/src/host/index.ts')).host.account.status()).f1tv.signedIn);
if (!signedIn) await fail('F1 TV is not signed in: sign in in the app, then run this again.');

const opened = await page.evaluate(
  async ({ sessionKey, year }) => {
    const { host, read } = await import('/src/host/index.ts');
    host.audio.setVolume({ volume: 0 });
    const events = (await host.catalog.events({ year })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
    let race = null;
    for (const e of events) {
      race = (await host.catalog.sessions({ pageId: e.pageId, year })).find((s) => s.type === 'race' && s.sessionKey === sessionKey);
      if (race) break;
    }
    if (!race) return { error: `No replay race with session key ${sessionKey} in ${year}` };
    await host.session.open({ contentId: race.contentId, title: race.title });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
    const ready = Date.now() + 60_000;
    while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
    return { title: race.title, state: read().sessionData.state, channels: host.session.feeds().map((c) => ({ id: c.id, kind: c.kind, label: c.label })) };
  },
  { sessionKey, year },
);
if (opened.error || opened.state !== 'ready') await fail(opened.error ?? `Session data is ${opened.state}`);
console.log(`opened ${opened.title}`);

const onboards = opened.channels.filter((c) => c.kind === 'onboard').slice(0, 3);
await page.evaluate(
  async ({ onboards }) => {
    const { host, read } = await import('/src/host/index.ts');
    host.playback.play();
    await host.playback.seek({ time: 1800 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && Math.abs(read().clock.timeSec - 1800) > 3) await new Promise((r) => setTimeout(r, 300));
    host.playback.pause();
    const drivers = read().sessionData.drivers?.slice(0, 2).map((d) => d.driver_number) ?? [];
    host.layout.add({
      items: [
        { type: 'video', props: { feed: onboards[0].id } },
        { type: 'video', props: { feed: onboards[1].id } },
        { type: 'timing_tower', props: {} },
        { type: 'gap_evolution', props: { drivers } },
      ],
    });
    host.suggestions.offer({
      items: [{ type: 'video', props: { feed: onboards[2].id } }, { type: 'race_control', props: {} }, { type: 'race_status', props: {} }],
    });
  },
  { onboards },
);
await page.waitForTimeout(12000);

// The page is laid out at each size by emulating the viewport, the content area a window of that size
// would have. Resizing the real window is up to the window manager, and a tiling one ignores it.
const setSize = async (w, h) => {
  await page.setViewportSize({ width: w, height: h });
  return page.evaluate(() => [innerWidth, innerHeight]);
};

/** What doesn't fit at the current size. */
const measure = () =>
  page.evaluate(() => {
    const cut = (el) => el.scrollWidth > el.clientWidth + 1;
    const wrapped = [...document.querySelectorAll('.palette-suggestion')].filter((row) => row.getBoundingClientRect().height > 30).length;
    const rows = document.querySelectorAll('.palette-suggestion').length;
    const titles = [...document.querySelectorAll('.tile-title')];
    const cutTitles = titles.filter(cut).map((t) => t.textContent.trim());
    const tiles = [...document.querySelectorAll('.stage-host')].map((t) => t.getBoundingClientRect());
    const smallest = tiles.length ? tiles.reduce((a, b) => (a.width * a.height < b.width * b.height ? a : b)) : null;
    const timeline = document.querySelector('[data-testid=timeline]');
    const strip = [...document.querySelectorAll('.strip-label-text')].filter(cut).length;
    return {
      viewport: `${innerWidth}x${innerHeight}`,
      wrappedSlashRows: rows ? `${wrapped}/${rows}` : '-',
      cutTileTitles: cutTitles.length,
      smallestTile: smallest ? `${Math.round(smallest.width)}x${Math.round(smallest.height)}` : '-',
      timelineOverflow: timeline ? cut(timeline) : '-',
      cutStripLabels: strip,
    };
  });

const palette = page.locator('[data-testid=palette-input]');
const results = [];
for (const [w, h] of sizes) {
  await setSize(w, h);
  await page.waitForTimeout(1500);
  await palette.fill('');
  await page.screenshot({ path: path.join(outDir, `shell-${w}x${h}.png`) });
  const idle = await measure();
  await palette.focus();
  await palette.fill('/');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, `palette-${w}x${h}.png`) });
  const menu = await measure();
  await palette.fill('');
  const row = { size: `${w}x${h}`, ...idle, wrappedSlashRows: menu.wrappedSlashRows };
  results.push(row);
  console.log(JSON.stringify(row));
}

// The agent settings last, since opening them leaves a line in the palette's history.
for (const [w, h] of sizes) {
  await setSize(w, h);
  await palette.fill('/settings-agent');
  await palette.press('Enter');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `agent-${w}x${h}.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

// The window's own minimum, as the window manager is told it.
const min = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize());
console.log(`window minimum size: ${min.join('x')}`);
console.table(results);
await stop();
