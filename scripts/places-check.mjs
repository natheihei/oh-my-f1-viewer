// Checks tiles that follow a place in the running order, in the real app over a real replay race, muted: P1's
// and P2's onboards and P1's telemetry, that each shows the car in its place at the playhead and says so in its
// title, that the P1 tiles are kept together, and that when P1 and P2 swap the two onboards trade videos in
// one render with no new stream, first by setting the order and then over a real change of lead. Prints what
// it finds and saves a screenshot of each step. Runs its own isolated OMFV: see scripts/isolated.mjs.
// Usage: node scripts/places-check.mjs <screenshot-dir> [lap] [session key]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/places-check.mjs <screenshot-dir> [lap] [session key]');
const LAP = Number(process.argv[3] ?? 5);
const SESSION = process.argv[4] ? Number(process.argv[4]) : null;
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'places' });
let failed = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failed += 1;
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const shoot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const host = (fn, arg) => page.evaluate(fn, arg);

/** The order, each tile's title, the videos and which tile holds each, and the groups. */
const state = () =>
  host(async () => {
    const { read, usePlaces, codeOf } = await import('/src/host/index.ts');
    const { groupOf } = await import('/src/layout/model.ts');
    const live = read();
    const titles = Object.fromEntries(
      [...document.querySelectorAll('.tile-titlebar[data-tile-id]')].map((bar) => [bar.dataset.tileId, bar.querySelector('.tile-title')?.textContent ?? '']),
    );
    const groups = groupOf(live.layout.tiles);
    return {
      order: [...usePlaces.getState().order],
      codes: usePlaces.getState().order.slice(0, 3).map((n) => codeOf(n)),
      tiles: live.layout.tiles.map((t, i) => ({ id: t.id, key: t.component.key, title: titles[t.id], group: groups[i] })),
      videos: Object.values(live.streams).map((v) => ({ id: v.id, feed: v.feed, tile: v.tile, status: v.status })),
      feeds: Object.fromEntries(live.feeds.filter((f) => f.kind === 'onboard').map((f) => [f.number, f.id])),
      health: live.health.map((p) => ({ scope: p.scope, state: p.state, message: p.message })),
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

/** The video each tile holds, by tile id. */
const held = (s, ids) => Object.fromEntries(ids.map((id) => [id, s.videos.find((v) => v.tile === id)]));

try {
  const race = await openRace(page, { sessionKey: SESSION });
  log(`opened ${race.title}`);
  await seekToLap(page, race.start ?? 0, LAP);

  const ids = await host(async () => {
    const { host } = await import('/src/host/index.ts');
    return host.layout.add({
      items: [
        { type: 'video', props: { driver: 'P1' } },
        { type: 'video', props: { driver: 'P2' } },
        { type: 'car_telemetry', props: { driver: 'P1' } },
      ],
    });
  });
  const [p1, p2, telemetry] = ids;
  let s = await waitFor(
    'both onboards play the cars in their places',
    (s) => s.order.length > 1 && [p1, p2].every((id, i) => s.videos.some((v) => v.tile === id && v.feed === s.feeds[s.order[i]] && v.status === 'ready')),
  );
  const [first, second] = s.order;
  log(`order at lap ${LAP}: ${s.codes.join(', ')}`);
  const title = (id) => s.tiles.find((t) => t.id === id)?.title;
  check('the P1 onboard is titled with the place and its car', title(p1) === `P1 ${s.codes[0]}`, title(p1));
  check('the P2 onboard is titled with the place and its car', title(p2) === `P2 ${s.codes[1]}`, title(p2));
  check('the telemetry is titled with the place and its car', title(telemetry) === `Telemetry P1 ${s.codes[0]}`, title(telemetry));
  const keys = [p1, p2, telemetry].map((id) => s.tiles.find((t) => t.id === id)?.key);
  check('the keys name the places', keys.join(' ') === 'onboard:P1 onboard:P2 car_telemetry:P1', keys.join(' '));
  const group = (id) => s.tiles.find((t) => t.id === id)?.group;
  check("P1's onboard and telemetry are one group, apart from P2's", group(p1) === 'driver-P1' && group(telemetry) === 'driver-P1' && group(p2) !== 'driver-P1', JSON.stringify(s.tiles));
  check('every tile draws', [p1, p2, telemetry].every((id) => s.health.find((h) => h.scope === id)?.state === 'drawn'), JSON.stringify(s.health));
  await shoot('1-following');

  // A swap, set by hand while paused, so the order isn't read again under it: the tiles trade videos.
  const before = held(s, [p1, p2]);
  const codes = s.codes;
  await host(async (order) => {
    const { usePlaces } = await import('/src/host/index.ts');
    usePlaces.setState({ order });
  }, [second, first, ...s.order.slice(2)]);
  s = await waitFor('the onboards swap cars', (s) => s.videos.some((v) => v.tile === p1 && v.feed === s.feeds[second]) && s.videos.some((v) => v.tile === p2 && v.feed === s.feeds[first]), 10_000);
  const after = held(s, [p1, p2]);
  check('P1 took over the video P2 was playing, with no new stream', after[p1]?.id === before[p2]?.id, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check('P2 took over the video P1 was playing, with no new stream', after[p2]?.id === before[p1]?.id);
  check('both stay ready through the swap', [p1, p2].every((id) => after[id]?.status === 'ready'), JSON.stringify(after));
  check('the titles follow', title(p1) === `P1 ${codes[1]}` && title(p2) === `P2 ${codes[0]}` && title(telemetry) === `Telemetry P1 ${codes[1]}`, JSON.stringify(s.tiles));
  await shoot('2-swapped-by-hand');

  // A real change of lead: find the next one after the playhead, play through it, and watch the tiles follow.
  const change = await host(async () => {
    const { host, read } = await import('/src/host/index.ts');
    const { rows } = await host.data.sql({ sql: 'SELECT date, driver_number, position FROM position ORDER BY date', asOf: 'session' });
    const now = read().sessionData.playheadMs;
    const at = new Map();
    let leader = null;
    for (const [i, r] of rows.entries()) {
      at.set(Number(r.driver_number), Number(r.position));
      // Both cars of a swap can come at one date: read the order once they all have.
      if (rows[i + 1]?.date === r.date) continue;
      // The car whose latest position is lowest, as the app reads the order.
      const lead = [...at].reduce((best, e) => (best === null || e[1] < best[1] ? e : best), null)?.[0] ?? null;
      if (leader != null && lead != null && lead !== leader && r.date > now + 5000) return { date: r.date, from: leader, to: lead, ahead: (r.date - now) / 1000 };
      leader = lead;
    }
    return null;
  });
  if (!change) log('no change of lead after the playhead: skipped the real swap');
  else {
    log(`lead changes from #${change.from} to #${change.to} in ${change.ahead.toFixed(0)} s`);
    await host(async (ahead) => {
      const { host, read } = await import('/src/host/index.ts');
      await host.playback.seek({ time: read().clock.timeSec + ahead - 8 });
      host.playback.play();
    }, change.ahead);
    s = await waitFor('the order is read again after the seek', (s) => s.order[0] === change.from, 20_000);
    check(`P1 is #${change.from} just before the change`, s.order[0] === change.from && s.videos.some((v) => v.tile === p1 && v.feed === s.feeds[change.from]), JSON.stringify(s.order.slice(0, 3)));
    s = await waitFor(`P1's onboard follows the new leader, #${change.to}`, (s) => s.order[0] === change.to && s.videos.some((v) => v.tile === p1 && v.feed === s.feeds[change.to] && v.status === 'ready'), 60_000);
    check('P1 is titled with the new leader', s.tiles.find((t) => t.id === p1)?.title === `P1 ${s.codes[0]}`, s.tiles.find((t) => t.id === p1)?.title);
    check('the telemetry follows too', s.tiles.find((t) => t.id === telemetry)?.title === `Telemetry P1 ${s.codes[0]}`);
    await host(async () => (await import('/src/host/index.ts')).host.playback.pause());
    await shoot('3-new-leader');
  }
} catch (e) {
  failed += 1;
  log(`FAIL ${e.stack ?? e}`);
} finally {
  log(failed ? `${failed} failed` : 'all ok');
  await stop();
  process.exit(failed ? 1 : 0);
}
