// Exercises the real grid surface in Electron, without needing any sign-in: rects line up with the
// layout, hosts survive grouping, mouse edits reach the layout tree, and only title bars take the mouse.
// Usage: node scripts/layout-check.mjs [screenshot-dir]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { _electron as electron } from 'playwright';

const outDir = process.argv[2] ?? tmpdir();
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();

const { CHROME_DESKTOP: _ignored, ...env } = process.env;
const app = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'f1a-layout-'))}`],
  env: { ...env, ELECTRON_START_URL: 'http://127.0.0.1:5199' },
});
const page = await app.firstWindow();
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
  window.layoutStore.layout.add(window.spec('MAIN'));
  window.layoutStore.layout.setMain('MAIN');
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

// Hamilton, then a group.
await page.evaluate(() => window.layoutStore.layout.add(window.spec('HAM')));
await settle();
await page.evaluate(() => {
  document.querySelector('[data-tile-key=HAM]').dataset.marker = 'same-element';
  window.layoutStore.layout.group([window.spec('NOR'), window.spec('LEC')]);
});
await settle();
rects = await hostRects();
check('main stays largest', rects.MAIN.w * rects.MAIN.h > rects.HAM.w * rects.HAM.h);
check('all hosts positioned', Object.values(rects).every((r) => r.visible && r.w > 0 && r.h > 0), Object.keys(rects).join(','));
check('group members side by side', rects.NOR.y === rects.LEC.y && rects.NOR.x + rects.NOR.w <= rects.LEC.x + 1, JSON.stringify([rects.NOR, rects.LEC]));
check('members sit inside the group below its title', await page.evaluate(() => {
  const group = document.querySelector('.tile-group').getBoundingClientRect();
  const nor = document.querySelector('[data-tile-key=NOR]').getBoundingClientRect();
  return nor.top >= group.top + 17 && nor.bottom <= group.bottom + 1 && nor.left >= group.left - 1 && nor.right <= group.right + 1;
}));
await page.screenshot({ path: path.join(outDir, 'layout-group.png') });

// Moving an on-screen tile into a group keeps its host element.
await page.evaluate(() => {
  window.layoutStore.layout.closeGroup('NOR');
  window.layoutStore.layout.group([window.spec('HAM'), window.spec('VER')]);
});
await settle();
check('host survives moving into a group', await page.evaluate(() => document.querySelector('[data-tile-key=HAM]').dataset.marker === 'same-element'));
check('host is inside the flat stage, not the grid', await page.evaluate(() => document.querySelector('[data-tile-key=HAM]').parentElement.dataset.testid === 'stage'));
rects = await hostRects();
check('moved tile follows its new placeholder', rects.HAM.visible && rects.HAM.w < surface.w / 2, JSON.stringify(rects.HAM));

await page.evaluate(() => window.layoutStore.layout.ungroup('HAM'));
await settle();
check('host survives ungrouping', await page.evaluate(() => document.querySelector('[data-tile-key=HAM]').dataset.marker === 'same-element'));

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
  layout.add(window.spec('MAIN'));
  layout.add(window.spec('HAM'));
});
await settle();
await page.keyboard.press('Control+Shift+P');
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
  const id = window.layoutStore.layout.snapshot().nodes.find((n) => n.component?.key === 'NEW').id;
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

// /auto-layout re-tiles with the main tile largest again, undoing the drag and resize.
await page.locator('[data-testid=palette-input]').fill('/auto-layout');
await page.keyboard.press('Enter');
await settle();
const retiled = await hostRects();
const retiledState = await page.evaluate(() => window.layoutStore.layout.snapshot());
check('/auto-layout clears the manual layout', retiledState.manual === false);
check('/auto-layout gives the main tile the largest slot again', retiled.MAIN.x === 0 && retiled.MAIN.w * retiled.MAIN.h > retiled.HAM.w * retiled.HAM.h, JSON.stringify(retiled));
await page.screenshot({ path: path.join(outDir, 'layout-auto.png') });

// Window resize.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
await page.waitForTimeout(400);
const small = await page.evaluate(() => {
  const r = document.querySelector('[data-testid=stage]').getBoundingClientRect();
  const hosts = [...document.querySelectorAll('.stage-host')].map((h) => h.getBoundingClientRect());
  return { bottom: r.bottom, maxBottom: Math.max(...hosts.map((h) => h.bottom)), maxRight: Math.max(...hosts.map((h) => h.right)), right: r.right };
});
check('tiles stay inside a resized window', small.maxBottom <= small.bottom + 2 && small.maxRight <= small.right + 2, JSON.stringify(small));

// Palette keyboard behaviour.
await page.evaluate(async () => {
  const { useSession } = await import('/src/data/session.ts');
  useSession.setState({ session: { title: 'x' } });
});
await page.waitForTimeout(100);
const openBefore = await page.locator('[data-testid=palette]').isVisible();
await page.keyboard.press('Control+Shift+P');
await page.waitForTimeout(100);
const openAfter = await page.locator('[data-testid=palette]').isVisible();
check('Ctrl+Shift+P toggles the palette once a session is open', openBefore !== openAfter, `${openBefore} -> ${openAfter}`);

await app.close();
await server.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
