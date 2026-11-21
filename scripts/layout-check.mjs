// Exercises the real grid surface in an OMFV of its own (see isolated.mjs), without needing any sign-in:
// rects line up with the layout, hosts survive re-tiling, mouse edits reach the layout by tile id, and only
// title bars take the mouse.
// Usage: node scripts/layout-check.mjs [screenshot-dir]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startIsolatedApp } from './isolated.mjs';

const outDir = path.resolve(process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'omfv-layout-')));
mkdirSync(outDir, { recursive: true });
const { page, stop } = await startIsolatedApp(outDir, { name: 'layout', scale: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}

await page.waitForSelector('[data-testid=palette]');
await page.evaluate(async () => {
  const store = await import('/src/layout/store.ts');
  window.layoutStore = store;
  window.spec = (key) => ({ type: 'test', key, label: key, props: {} });
});

const hostRects = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.stage-host')].map((h) => {
        const r = h.getBoundingClientRect();
        return [h.dataset.tileKey, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: h.style.visibility === 'visible' }];
      }),
    ),
  );
const settle = () => page.waitForTimeout(350);
const TITLE = 22;

// Main fills the surface. It is given the main place, as opening a session does for the main feed.
await page.evaluate(() => {
  window.layoutStore.layout.setMain(window.layoutStore.layout.add(window.spec('MAIN')));
});
await settle();
let rects = await hostRects();
const surface = await page.evaluate(() => {
  const r = document.querySelector('[data-testid=stage]').getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
check('main fills the surface below its title bar', rects.MAIN.w === surface.w && rects.MAIN.y === TITLE && Math.abs(rects.MAIN.h + TITLE - surface.h) <= 2, JSON.stringify(rects.MAIN));
check('the title bar shows the label and a close button', await page.evaluate(() => {
  const bar = document.querySelector('.tile-titlebar');
  return bar?.querySelector('.tile-title')?.textContent === 'MAIN' && bar.querySelector('.tile-close') != null;
}));

// Hamilton, Norris and Leclerc.
await page.evaluate(() => window.layoutStore.layout.add(window.spec('HAM')));
await settle();
await page.evaluate(() => {
  document.querySelector('[data-tile-key=HAM]').dataset.marker = 'same-element';
  for (const key of ['NOR', 'LEC']) window.layoutStore.layout.add(window.spec(key));
});
await settle();
rects = await hostRects();
check('main stays largest', rects.MAIN.w * rects.MAIN.h > rects.HAM.w * rects.HAM.h);
check('all hosts positioned', Object.values(rects).every((r) => r.visible && r.w > 0 && r.h > 0), Object.keys(rects).join(','));
check('host survives re-tiling', await page.evaluate(() => document.querySelector('[data-tile-key=HAM]').dataset.marker === 'same-element'));
check('host is inside the flat stage, not the grid', await page.evaluate(() => document.querySelector('[data-tile-key=HAM]').parentElement.dataset.testid === 'stage'));
await page.screenshot({ path: path.join(outDir, 'layout-four.png') });

// Many tiles.
await page.evaluate(() => {
  for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) window.layoutStore.layout.add(window.spec(key));
});
await settle();
rects = await hostRects();
const list = Object.entries(rects);
let overlaps = 0;
for (let i = 0; i < list.length; i += 1) {
  for (let j = i + 1; j < list.length; j += 1) {
    const [a, b] = [list[i][1], list[j][1]];
    if (a.x + 2 < b.x + b.w && b.x + 2 < a.x + a.w && a.y + 2 < b.y + b.h && b.y + 2 < a.y + a.h) overlaps += 1;
  }
}
check('no tiles overlap with many streams', overlaps === 0, `${list.length} tiles, ${overlaps} overlaps`);
await page.screenshot({ path: path.join(outDir, 'layout-many.png') });

// Mouse: drag the main tile's corner, then the tile itself.
await page.evaluate(() => {
  const { layout } = window.layoutStore;
  layout.clear();
  layout.setMain(layout.add(window.spec('MAIN')));
  layout.add(window.spec('HAM'));
});
await settle();
await page.keyboard.press('Control+K');
const before = await hostRects();
// The body of a tile belongs to its component: the mouse reaches it, and pressing there drags nothing.
await page.evaluate(() => {
  const host = document.querySelector('[data-tile-key=HAM]');
  host.innerHTML = '<button id="inner" style="position:absolute;inset:0">inside</button>';
  window.innerClicks = 0;
  host.querySelector('#inner').addEventListener('click', () => (window.innerClicks += 1));
});
const middle = { x: before.HAM.x + before.HAM.w / 2, y: before.HAM.y + before.HAM.h / 2 };
check('the component gets the mouse, not the grid', await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'inner', middle));
await page.mouse.click(middle.x, middle.y);
check('clicks inside a tile reach its component', (await page.evaluate(() => window.innerClicks)) === 1);
await page.mouse.move(middle.x, middle.y);
await page.mouse.down();
await page.mouse.move(before.MAIN.x + 200, before.MAIN.y + 300, { steps: 12 });
await page.mouse.up();
await settle();
check('dragging inside a tile does not move it', (await hostRects()).HAM.x === before.HAM.x);
check('the body shows no move cursor', await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor !== 'move', middle));

// With Alt held the whole tile is the grip: the body drags it, and the component gets nothing.
await page.keyboard.down('Alt');
check('with Alt held the body shows the move cursor', await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor === 'move', middle));
await page.mouse.move(middle.x, middle.y);
await page.mouse.down();
await page.mouse.move(before.MAIN.x + 200, before.MAIN.y + 300, { steps: 12 });
await page.screenshot({ path: path.join(outDir, 'layout-alt-drag.png') });
await page.mouse.up();
await page.keyboard.up('Alt');
await settle();
const altDragged = await hostRects();
check('Alt and a drag inside a tile moves it', altDragged.HAM.x < altDragged.MAIN.x, JSON.stringify({ before: [before.HAM.x, before.MAIN.x], after: [altDragged.HAM.x, altDragged.MAIN.x] }));
check('the component got no click from the Alt drag', (await page.evaluate(() => window.innerClicks)) === 1);
check('letting go of Alt gives the body back to the component', await page.evaluate(() => {
  const r = document.querySelector('[data-tile-key=HAM]').getBoundingClientRect();
  return getComputedStyle(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)).cursor !== 'move';
}));
// Put it back, so the title bar drag below starts from the same layout.
await page.evaluate(() => {
  const { layout } = window.layoutStore;
  layout.clear();
  layout.setMain(layout.add(window.spec('MAIN')));
  layout.add(window.spec('HAM'));
});
await settle();

// Drag by the title bar.
await page.mouse.move(before.HAM.x + 40, before.HAM.y - TITLE / 2);
await page.mouse.down();
await page.mouse.move(before.MAIN.x + 200, before.MAIN.y + 300, { steps: 12 });
await page.waitForTimeout(100);
await page.mouse.up();
await settle();
let after = await page.evaluate(() => window.layoutStore.layout.snapshot());
rects = await hostRects();
// GridStack either pushes the other tile aside when there's room, or we swap them. Both are fine.
check('dragging a tile onto another moves it there, without overlap', rects.HAM.x < rects.MAIN.x && rects.HAM.x + rects.HAM.w <= rects.MAIN.x + 2, JSON.stringify({ before: [before.HAM.x, before.MAIN.x], after: [rects.HAM.x, rects.MAIN.x] }));
check('a drag counts as a manual layout', after.manual === true);

// Resize the tile on the left by its right edge; then a new tile uses the freed space.
await page.mouse.move(rects.HAM.x + rects.HAM.w - 3, rects.HAM.y + rects.HAM.h / 2);
await page.mouse.down();
await page.mouse.move(rects.HAM.x + rects.HAM.w - 400, rects.HAM.y + rects.HAM.h / 2, { steps: 12 });
await page.mouse.up();
await settle();
const resized = await hostRects();
check('resizing by the edge works and the host follows', resized.HAM.w < rects.HAM.w - 200, `${rects.HAM.w} -> ${resized.HAM.w}`);
await page.evaluate(() => window.layoutStore.layout.add(window.spec('NEW')));
await settle();
const placed = await hostRects();
check('a new tile uses free space and leaves mouse edits alone', placed.HAM.w === resized.HAM.w && placed.NEW.visible && placed.NEW.x >= resized.HAM.x + resized.HAM.w - 2, JSON.stringify(placed.NEW));

// The close button removes just that tile.
const closeBox = await page.evaluate(() => {
  const id = window.layoutStore.layout.tiles().find((t) => t.component.key === 'NEW').id;
  const r = document.querySelector(`.grid-stack-item[gs-id="${id}"] .tile-close`).getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(closeBox.x, closeBox.y);
await settle();
const remaining = await page.evaluate(() => window.layoutStore.layout.tiles().map((t) => t.component.key).sort().join(','));
check('the close button removes its tile', remaining === 'HAM,MAIN', remaining);
const afterClose = await hostRects();
check('closing leaves the other tiles where they were', JSON.stringify(afterClose.HAM) === JSON.stringify(placed.HAM), JSON.stringify([placed.HAM, afterClose.HAM]));
await page.screenshot({ path: path.join(outDir, 'layout-closed.png') });

// /auto-layout works on a session: typed with none open, it only says to open one, and the layout stays.
await page.locator('[data-testid=palette-input]').fill('/auto-layout');
await page.keyboard.press('Enter');
await settle();
check('/auto-layout without a session says to open one', await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid=palette-history] .palette-system')].some((l) => l.textContent.includes('/auto-layout works on a session')),
));
check('/auto-layout without a session leaves the manual layout', (await page.evaluate(() => window.layoutStore.layout.snapshot())).manual === true);

// With a session open (faked, as there's no sign-in here), /auto-layout re-tiles with the main tile largest
// again, undoing the drag and resize.
await page.evaluate(async () => {
  const { useSession } = await import('/src/data/session.ts');
  useSession.setState({ session: { title: 'x' } });
});
await page.waitForTimeout(100);
await page.locator('[data-testid=palette-input]').fill('/auto-layout');
await page.keyboard.press('Enter');
await settle();
const retiled = await hostRects();
const retiledState = await page.evaluate(() => window.layoutStore.layout.snapshot());
check('/auto-layout clears the manual layout', retiledState.manual === false);
check('/auto-layout gives the main tile the largest slot again', retiled.MAIN.x === 0 && retiled.MAIN.w * retiled.MAIN.h > retiled.HAM.w * retiled.HAM.h, JSON.stringify(retiled));
await page.screenshot({ path: path.join(outDir, 'layout-auto.png') });

// Window resize.
await page.setViewportSize({ width: 1000, height: 640 });
await page.waitForTimeout(400);
const small = await page.evaluate(() => {
  const r = document.querySelector('[data-testid=stage]').getBoundingClientRect();
  const hosts = [...document.querySelectorAll('.stage-host')].map((h) => h.getBoundingClientRect());
  return { bottom: r.bottom, maxBottom: Math.max(...hosts.map((h) => h.bottom)), maxRight: Math.max(...hosts.map((h) => h.right)), right: r.right };
});
check('tiles stay inside a resized window', small.maxBottom <= small.bottom + 2 && small.maxRight <= small.right + 2, JSON.stringify(small));

// Palette keyboard behaviour, with the session from above still open.
const openBefore = await page.locator('[data-testid=palette]').isVisible();
await page.keyboard.press('Control+K');
await page.waitForTimeout(100);
const openAfter = await page.locator('[data-testid=palette]').isVisible();
check('Ctrl+K toggles the palette once a session is open', openBefore !== openAfter, `${openBefore} -> ${openAfter}`);

// The mouse does the same: the chevron on the palette's top edge folds it to its input row, and a click unfolds it.
if (!(await page.locator('[data-testid=palette]').isVisible())) await page.keyboard.press('Control+K');
await page.waitForTimeout(300);
const openBox = await page.locator('[data-testid=palette]').boundingBox();
await page.locator('[data-testid=palette-hide]').click();
await page.waitForTimeout(300);
const folded = page.locator('[data-testid=palette-folded]');
check('the chevron folds the palette to its input row', !(await page.locator('[data-testid=palette]').isVisible()) && (await folded.isVisible()));
const foldedBox = await folded.boundingBox();
check('the folded palette is as wide as the palette, and one row high', foldedBox != null && Math.abs(foldedBox.width - openBox.width) <= 1 && Math.abs(foldedBox.x - openBox.x) <= 1 && foldedBox.height <= 34, JSON.stringify(foldedBox));
check('the folded palette names the shortcut', /Ctrl\+K|⌘K/.test((await folded.textContent()) ?? ''));
check('the folded palette is see-through', await folded.evaluate((b) => !/^rgb\(/.test(getComputedStyle(b).backgroundColor)));
await page.screenshot({ path: path.join(outDir, 'palette-folded.png') });

// Left alone, the folded palette shows a tip in place of its placeholder. A tip stays 20s, so the first takes that long.
const foldedLine = page.locator('[data-testid=palette-folded-line]');
check('the folded palette starts on its placeholder', (await foldedLine.textContent()) === 'ask for anything on screen' && (await foldedLine.getAttribute('data-tip')) == null);
await page.mouse.move(5, 5);
const tipShown = await page.waitForSelector('[data-testid=palette-folded-line][data-tip]', { timeout: 25_000 }).catch(() => null);
const tipText = (await foldedLine.textContent()) ?? '';
check('the folded palette shows a tip after a while', tipShown != null && /^tip/.test(tipText), tipText);
const tipBox = await folded.boundingBox();
check('a tip keeps the folded palette one row high, and fits it', tipBox != null && tipBox.height === foldedBox.height && (await foldedLine.evaluate((el) => el.scrollWidth <= el.clientWidth)), JSON.stringify(tipBox));
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, 'palette-folded-tip.png') });
await folded.click();
await page.waitForTimeout(300);
check('clicking the folded palette opens the palette, with the cursor in the input', await page.locator('[data-testid=palette]').isVisible() && (await page.evaluate(() => !!document.activeElement?.closest('[data-testid=palette]'))));

// The key at the end of the input row changes the shortcut: a click records the next key, a taken one isn't kept.
const key = page.locator('[data-testid=palette-key]');
await key.click();
await page.keyboard.press('Control+C');
await page.waitForTimeout(100);
check('a taken key is named and not kept', /copy/.test((await page.locator('[data-testid=palette-key-hint]').textContent()) ?? ''));
await page.screenshot({ path: path.join(outDir, 'palette-key-refused.png') });
await page.keyboard.press('Control+Shift+J');
await page.waitForTimeout(100);
check('a free key is kept and written on the palette', /Ctrl\+Shift\+J|⇧⌘J/.test((await key.textContent()) ?? ''));
await page.screenshot({ path: path.join(outDir, 'palette-key-changed.png') });
await page.keyboard.press('Control+Shift+J');
await page.waitForTimeout(300);
check('the new key hides the palette', !(await page.locator('[data-testid=palette]').isVisible()));
await page.keyboard.press('Control+Shift+J');
await page.waitForTimeout(300);
await key.click();
await page.keyboard.press('Backspace');
await page.waitForTimeout(100);
check('backspace while recording goes back to the default', /Ctrl\+K|⌘K/.test((await key.textContent()) ?? ''));

await stop();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
