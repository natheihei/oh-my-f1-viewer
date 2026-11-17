// Checks components that show video, in the real app over a real replay race, muted: the battle tile with its
// two onboards and its list of fights, the same onboard in a video tile of its own at once, where the sound
// goes as pictures are clicked, switched and closed, and the chase tile. Prints what it finds and saves a
// screenshot of each step. Runs its own isolated OMFV: see scripts/isolated.mjs.
// Usage: node scripts/battle-check.mjs <screenshot-dir> [lap] [session key]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/battle-check.mjs <screenshot-dir> [lap] [session key]');
const LAP = Number(process.argv[3] ?? 12);
const SESSION = process.argv[4] ? Number(process.argv[4]) : null;
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'battle' });
let failed = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failed += 1;
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const shoot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const host = (fn, arg) => page.evaluate(fn, arg);

/** What the app says now: the videos, the heard one, and each tile's title and slots. */
const state = () =>
  host(async () => {
    const { read } = await import('/src/host/index.ts');
    const live = read();
    const titles = Object.fromEntries(
      [...document.querySelectorAll('.tile-titlebar[data-tile-id]')].map((bar) => [
        bar.dataset.tileId,
        { title: bar.querySelector('.tile-title')?.textContent ?? '', aud: bar.querySelector('.tile-slot-audio:not([hidden])')?.textContent ?? null },
      ]),
    );
    return {
      videos: Object.values(live.streams).map((v) => ({ id: v.id, feed: v.feed, tile: v.tile, quiet: v.quiet, status: v.status })),
      audio: live.audio,
      tiles: live.layout.tiles.map((t) => ({ id: t.id, type: t.component.type, ...titles[t.id] })),
      headers: live.headers,
    };
  });

const waitFor = async (what, ok, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await state();
    if (ok(s)) return s;
    await page.waitForTimeout(500);
  }
  const s = await state();
  check(what, false, JSON.stringify(s));
  return s;
};

try {
  const race = await openRace(page, { sessionKey: SESSION });
  log(`opened ${race.title}`);
  await seekToLap(page, race.start ?? 0, LAP);

  // A previewed onboard handed to its tile: the tile takes over the preview's video, still playing.
  const preview = await host(async () => {
    const { host, read } = await import('/src/host/index.ts');
    const feed = read().feeds.find((f) => f.kind === 'onboard')?.id;
    host.suggestions.offer({ items: [{ type: 'video', props: { feed } }] });
    const deadline = Date.now() + 60_000;
    const quiet = () => Object.values(read().streams).find((v) => v.feed === feed && v.quiet && v.status === 'ready');
    while (Date.now() < deadline && !quiet()) await new Promise((r) => setTimeout(r, 500));
    return { feed, video: quiet()?.id ?? null };
  });
  check('a suggestion previews its onboard, quietly', preview.video != null, JSON.stringify(preview));
  await shoot('0-preview');
  const handed = await host(async (feed) => {
    const { host, read } = await import('/src/host/index.ts');
    host.suggestions.add({ key: feed });
    await new Promise((r) => setTimeout(r, 1500));
    const tile = read().layout.tiles.find((t) => t.component.key === feed)?.id;
    return { tile, videos: Object.values(read().streams).filter((v) => v.feed === feed) };
  }, preview.feed);
  check(
    'adding it hands the same video to the tile, still ready',
    handed.videos.length === 1 && handed.videos[0].id === preview.video && handed.videos[0].tile === handed.tile && !handed.videos[0].quiet && handed.videos[0].status === 'ready',
    JSON.stringify(handed),
  );
  await host(async (tile) => (await import('/src/host/index.ts')).host.layout.remove({ tiles: [tile] }), handed.tile);
  await host(async () => (await import('/src/host/index.ts')).host.suggestions.newTurn());

  // The battle beside the main feed.
  const [battle] = await host(async () => {
    const { host } = await import('/src/host/index.ts');
    return host.layout.add({ items: [{ type: 'battle', props: {} }] });
  });
  let s = await waitFor('the battle starts on a fight with both pictures ready', (s) => s.headers[battle]?.drivers?.length === 2 && s.videos.filter((v) => v.tile === battle && v.status === 'ready').length === 2);
  const pair = s.headers[battle]?.drivers ?? [];
  const fights = await page.locator(`[data-testid=battle-fights] li`).count();
  check('the battle lists the fights', fights > 0, `${fights} fights`);
  check('its title bar names the pair', /Battle/.test(s.tiles.find((t) => t.id === battle)?.title ?? ''), s.tiles.find((t) => t.id === battle)?.title);
  await shoot('1-battle');

  // The first of the pair's onboard in a tile of its own as well: two videos of one feed.
  const feedA = s.videos.find((v) => v.tile === battle)?.feed;
  const [own] = await host(async (feed) => {
    const { host } = await import('/src/host/index.ts');
    return host.layout.add({ items: [{ type: 'video', props: { feed } }] });
  }, feedA);
  s = await waitFor('the same onboard plays in two tiles', (s) => s.videos.filter((v) => v.feed === feedA && v.status === 'ready').length === 2);
  check('as two videos', new Set(s.videos.filter((v) => v.feed === feedA).map((v) => v.id)).size === 2);
  await shoot('2-same-feed-twice');

  // A click on the battle's first picture makes it the one heard. The volume is 0, so it reads "mute".
  await page.locator(`.video[data-feed="${feedA}"]`).first().waitFor();
  const battlePicture = page.locator(`.battle .video[data-feed="${feedA}"]`);
  await battlePicture.click();
  s = await state();
  const heardVideo = s.videos.find((v) => v.id === s.audio);
  check('a click makes that picture heard', heardVideo?.tile === battle && heardVideo?.feed === feedA, JSON.stringify(heardVideo));
  check("the battle's title bar has the sound", s.tiles.find((t) => t.id === battle)?.aud === 'mute', JSON.stringify(s.tiles));
  check('and the picture says so, with two in its tile', await battlePicture.evaluate((el) => el.classList.contains('video-many') && el.dataset.heard === 'muted'));
  check('the volume stays at 0', (await host(async () => (await import('/src/host/index.ts')).read().volume)) === 0);
  await battlePicture.hover();
  await shoot('3-heard-in-battle');

  // Another fight: the sound stays in the battle, on its first picture.
  const other = page.locator('[data-testid=battle-fights] button[aria-pressed=false]').first();
  if ((await other.count()) > 0) {
    await other.click();
    s = await waitFor('picking another fight shows it', (s) => JSON.stringify(s.headers[battle]?.drivers) !== JSON.stringify(pair));
    const heard = s.videos.find((v) => v.id === s.audio);
    check('the sound stays in the battle', heard?.tile === battle, JSON.stringify({ heard, pair: s.headers[battle]?.drivers }));
    await waitFor('the new pair plays', (s) => s.videos.filter((v) => v.tile === battle && v.status === 'ready').length === 2);
    await shoot('4-another-fight');
  } else log('only one fight at this lap: switching is not checked');

  // Closing the battle: the sound moves on.
  await host(async (tile) => (await import('/src/host/index.ts')).host.layout.remove({ tiles: [tile] }), battle);
  s = await waitFor('the battle goes', (s) => !s.videos.some((v) => v.tile === battle));
  const after = s.videos.find((v) => v.id === s.audio);
  check('the sound goes to another video of its feed, or the main feed', after != null, JSON.stringify({ after, videos: s.videos }));
  log(`heard after closing: ${after?.feed} in ${after?.tile}`);

  // A chase of the car behind in the first fight.
  await host(async (tile) => (await import('/src/host/index.ts')).host.layout.remove({ tiles: [tile] }), own);
  const [chase] = await host(async (driver) => (await import('/src/host/index.ts')).host.layout.add({ items: [{ type: 'chase', props: { driver } }] }), pair[1]);
  await waitFor('the chase plays its onboard', (s) => s.videos.some((v) => v.tile === chase && v.status === 'ready'));
  const ahead = await page.locator('[data-testid=chase-ahead]').textContent().catch(() => null);
  check('the chase names the car ahead and the gap', ahead != null && /ahead/i.test(ahead), ahead ?? 'nothing');
  await shoot('5-chase');
} catch (e) {
  failed += 1;
  log('FAIL', e.message);
} finally {
  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close()).catch(() => {});
  await stop();
}
log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
