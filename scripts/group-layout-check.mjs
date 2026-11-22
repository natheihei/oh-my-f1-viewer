// Adds suggestions to a real replay race in an OMFV of its own (see isolated.mjs), clicked in turn about:
// an onboard, its telemetry and its pedals for each of two drivers. Auto-layout keeps each driver's
// tiles together as a block, and lays the two blocks out the same way round, in line. Then a batch of
// two charts about no one driver, which stay together as the newest group, and a window drag, which
// re-tiles only once it has settled. Needs the F1 TV login.
// Usage: node scripts/group-layout-check.mjs [screenshot-dir]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRace, startIsolatedApp } from './isolated.mjs';

const outDir = path.resolve(process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'omfv-group-layout-')));
mkdirSync(outDir, { recursive: true });
const { page, stop } = await startIsolatedApp(outDir, { name: 'group-layout', scale: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}
const settle = (ms = 1500) => page.waitForTimeout(ms);

try {
  await page.waitForSelector('[data-testid=palette]');
  const race = await openRace(page);
  console.log(`opened ${race.title}`);
  // Keeps frames coming on a hidden workspace, so screenshots don't time out.
  await page.evaluate(() => {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;animation:omfv-blink 1s infinite;z-index:9999';
    const style = document.createElement('style');
    style.textContent = '@keyframes omfv-blink{from{opacity:0}to{opacity:1}}';
    document.head.append(style);
    document.body.append(dot);
  });
  await page.evaluate(async () => {
    const [{ host, read }, { layout, useLayout }, model, solve] = await Promise.all([
      import('/src/host/index.ts'),
      import('/src/layout/store.ts'),
      import('/src/layout/model.ts'),
      import('/src/layout/solve.ts'),
    ]);
    Object.assign(window, { host, read, layout, useLayout, model, solve });
  });

  // The first two drivers with an onboard feed.
  const drivers = await page.evaluate(() => {
    const roster = window.read().sessionData.drivers ?? [];
    return window
      .read()
      .feeds.filter((f) => f.kind === 'onboard')
      .map((f) => ({ feed: f.id, n: roster.find((d) => Object.values(d).includes(f.label))?.driver_number }))
      .filter((d) => d.n != null)
      .slice(0, 2);
  });
  if (drivers.length < 2) throw new Error(`No two drivers with an onboard: ${JSON.stringify(await page.evaluate(() => window.read().feeds.slice(0, 3)))}`);
  const batch = ({ n, feed }) => [
    { type: 'video', props: { feed } },
    { type: 'car_telemetry', props: { driver: n } },
    { type: 'pedal_barcode', props: { driver: n } },
  ];
  // Two offers in one turn: two batches.
  const keys = await page.evaluate(
    (batches) => {
      window.host.suggestions.newTurn();
      return batches.map((items) => {
        const before = new Set(window.read().suggestions.items.map((i) => i.key));
        window.host.suggestions.offer({ items });
        return window.read().suggestions.items.map((i) => i.key).filter((k) => !before.has(k));
      });
    },
    [batch(drivers[0]), batch(drivers[1])],
  );
  check('each offer put its three suggestions in the strip', keys.every((k) => k.length === 3), JSON.stringify(keys));
  await settle();
  // Clicked in turn about: one from the first batch, one from the second.
  for (let i = 0; i < 3; i += 1) {
    for (const k of keys) {
      await page.locator(`[data-testid=suggestion][data-key="${k[i]}"]`).click();
      await settle(800);
    }
  }
  await settle(3000);

  /** The tiles by label, what each belongs with, and how far apart each group's are: see `apart` in solve.ts. */
  const state = () =>
    page.evaluate(() => {
      const s = window.layout.snapshot();
      const boxes = new Map(s.tiles.map((t, i) => [i, { x: t.x, y: t.y, w: t.w, h: t.h }]));
      const groupOf = window.model.groupOf(s.tiles);
      const by = new Map();
      groupOf.forEach((g, i) => g && by.set(g, [...(by.get(g) ?? []), i]));
      return {
        manual: s.manual,
        tiles: s.tiles.map((t, i) => ({ label: t.component.label, type: t.component.type, group: groupOf[i] ?? null, rect: [t.x, t.y, t.w, t.h] })),
        groups: Object.fromEntries(by),
        apart: window.solve.apart(boxes, [...by.values()], { columns: 24, rows: 24 }),
      };
    });
  let s = await state();
  console.log('  two drivers:', JSON.stringify(s.tiles));
  const names = Object.keys(s.groups);
  check('six tiles were added, three about each driver', names.length === 2 && names.every((g) => g.startsWith('driver-') && s.groups[g].length === 3), JSON.stringify(s.groups));
  check('the layout is still an auto layout', !s.manual);
  check("each driver's tiles make a block with no other tile in it", s.apart === 0, `apart ${s.apart.toFixed(3)}`);
  // The same way round, in line: each tile is one step from the other driver's tile of its kind, the same step for all three.
  const alike = () => {
    const of = (group, type) => s.tiles.find((t) => t.group === group && t.type === type).rect;
    const steps = ['video', 'car_telemetry', 'pedal_barcode'].map((type) => {
      const [a, b] = names.map((g) => of(g, type));
      return { step: `${Math.sign(b[0] - a[0])},${Math.sign(b[1] - a[1])}`, sized: Math.abs(a[2] - b[2]) <= 1 && Math.abs(a[3] - b[3]) <= 1 };
    });
    return { steps, inLine: new Set(steps.map((x) => x.step)).size === 1 && ['1,0', '-1,0', '0,1', '0,-1'].includes(steps[0].step), sized: steps.every((x) => x.sized) };
  };
  // With only these six, lining the blocks up would cost the main feed too much: one may take the rail and one the band.
  console.log('  alike:', JSON.stringify(alike()));
  await page.screenshot({ path: path.join(outDir, '1-two-drivers.png') });

  // A later batch about no one driver: its two charts stay together.
  const later = await page.evaluate(() => {
    window.host.suggestions.newTurn();
    window.host.suggestions.offer({ items: [{ type: 'tyre_strategy', props: {} }, { type: 'race_control', props: {} }] });
    return window.read().suggestions.items.map((i) => i.key);
  });
  await settle();
  for (const key of later) {
    await page.locator(`[data-testid=suggestion][data-key="${key}"]`).click();
    await settle(800);
  }
  await settle(3000);
  s = await state();
  console.log('  with a batch:', JSON.stringify(s.tiles));
  const third = Object.keys(s.groups).find((g) => g.startsWith('batch-'));
  check('the batch is a third group, of its two charts', Object.keys(s.groups).length === 3 && s.groups[third]?.length === 2, JSON.stringify(s.groups));
  check('every group is still a block, or close to one', s.apart < 0.05, `apart ${s.apart.toFixed(3)}`);
  const lined = alike();
  check("the two drivers' blocks are laid out the same way round, in line, at one size", lined.inLine && lined.sized, JSON.stringify(lined.steps));
  await page.screenshot({ path: path.join(outDir, '2-with-a-batch.png') });

  // A window drag: the grid's size changes thirty times in a row. Nothing is re-tiled until it holds still.
  const drag = await page.evaluate(async () => {
    const base = window.layout.snapshot().cell;
    const rects = () => JSON.stringify(window.layout.tiles().map((t) => [t.x, t.y, t.w, t.h]));
    const before = rects();
    const t0 = performance.now();
    for (let i = 1; i <= 30; i += 1) window.layout.measure({ w: base.w * (1 - i * 0.015), h: base.h });
    const each = (performance.now() - t0) / 30;
    const during = rects();
    const t1 = performance.now();
    while (rects() === during && performance.now() - t1 < 2000) await new Promise((r) => setTimeout(r, 20));
    const settled = { moved: rects() !== before, after: Math.round(performance.now() - t1) };
    // Back to the window's real size.
    window.layout.measure(base);
    await new Promise((r) => setTimeout(r, 500));
    return { each, held: during === before, ...settled, back: rects() === before };
  });
  console.log('  drag:', JSON.stringify(drag));
  check('a step of a window drag costs under a millisecond, and moves no tile', drag.each < 1 && drag.held, `${drag.each.toFixed(3)} ms a step`);
  check('the grid is re-tiled for the narrower window once it holds still', drag.moved, `after ${drag.after} ms`);
  check('and back as it was at the first size', drag.back);
} finally {
  await stop();
}
console.log(failures ? `${failures} failed` : 'all passed', `screenshots in ${outDir}`);
process.exit(failures ? 1 : 0);
