// Adds suggestions one by one to a real replay race in an OMFV of its own (see isolated.mjs): while the
// layout hasn't been arranged by hand, each one re-tiles the grid as /auto-layout does; once a tile has been
// moved, a new one goes into the biggest gap and the rest stay put. Needs the F1 TV login.
// Usage: node scripts/auto-layout-add-check.mjs [screenshot-dir]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRace, startIsolatedApp } from './isolated.mjs';

const outDir = path.resolve(process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'omfv-auto-add-')));
mkdirSync(outDir, { recursive: true });
const { page, stop } = await startIsolatedApp(outDir, { name: 'auto-add', scale: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}
const settle = () => page.waitForTimeout(1500);

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
    const [{ host, read }, { layout }, model] = await Promise.all([import('/src/host/index.ts'), import('/src/layout/store.ts'), import('/src/layout/model.ts')]);
    Object.assign(window, { host, read, layout, model });
  });
  const pair = race.drivers.slice(0, 2);
  const state = () =>
    page.evaluate(() => {
      const s = window.layout.snapshot();
      const rects = (tiles) => Object.fromEntries(tiles.map((t) => [t.component.label, [t.x, t.y, t.w, t.h]]));
      return { manual: s.manual, rects: rects(s.tiles), retiled: rects(window.model.autoLayout(s).tiles) };
    });
  const addSuggestion = async (item) => {
    await page.evaluate((item) => {
      window.host.suggestions.newTurn();
      window.host.suggestions.offer({ items: [item] });
    }, item);
    await settle();
    const key = await page.evaluate(() => window.read().suggestions.items[0].key);
    await page.locator(`[data-testid=suggestion][data-key="${key}"]`).click();
    await settle();
  };

  let s = await state();
  check('opening the race lays out the main feed automatically', !s.manual, JSON.stringify(s.rects));
  await page.screenshot({ path: path.join(outDir, '0-opened.png') });

  const items = [
    { type: 'timing_tower', props: {} },
    { type: 'gap_evolution', props: { driver_a: pair[0], driver_b: pair[1] } },
    { type: 'race_control', props: {} },
    { type: 'tyre_strategy', props: {} },
    { type: 'track_map', props: { drivers: pair } },
  ];
  for (const [i, item] of items.entries()) {
    const before = (await state()).rects;
    await addSuggestion(item);
    s = await state();
    console.log(`  after ${item.type}:`, JSON.stringify(s.rects));
    check(`adding ${item.type} re-tiles the grid`, !s.manual && JSON.stringify(s.rects) === JSON.stringify(s.retiled));
    check(`${item.type} is on screen`, Object.keys(s.rects).length === Object.keys(before).length + 1);
    await page.screenshot({ path: path.join(outDir, `${i + 1}-added-${item.type}.png`) });
  }

  // Arrange by hand: halve the main feed's width, as a mouse resize does, which leaves a big gap.
  await page.evaluate(() => {
    const t = window.layout.tiles()[0];
    window.layout.mouseEdit(t.id, { x: t.x, y: t.y, w: Math.floor(t.w / 2), h: t.h });
  });
  await settle();
  const handArranged = await state();
  check('a mouse edit makes the layout manual', handArranged.manual);
  await page.screenshot({ path: path.join(outDir, '6-hand-arranged.png') });

  await addSuggestion({ type: 'sector_table', props: { driver_a: pair[0], driver_b: pair[1] } });
  s = await state();
  console.log('  after sector_table:', JSON.stringify(s.rects));
  const kept = Object.entries(handArranged.rects).every(([label, r]) => JSON.stringify(s.rects[label]) === JSON.stringify(r));
  check('in a hand-arranged layout, adding leaves the other tiles where they were', s.manual && kept);
  await page.screenshot({ path: path.join(outDir, '7-added-in-manual.png') });
} finally {
  await stop();
}
console.log(failures ? `${failures} failed` : 'all passed', `screenshots in ${outDir}`);
process.exit(failures ? 1 : 0);
