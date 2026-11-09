// Exercises the suggestion strip in Electron without any sign-in: a session with channels but no
// streams, suggestions offered the way the agent's tool offers them, and the user answering them by
// keyboard, click, and drag.
// Usage: node scripts/suggestions-check.mjs [screenshot-dir]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { _electron as electron } from 'playwright';

const outDir = process.argv[2] ?? tmpdir();
const server = await createServer({ server: { port: 5197, strictPort: true }, logLevel: 'error' });
await server.listen();

const { CHROME_DESKTOP: _ignored, ...env } = process.env;
const app = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'f1a-suggest-'))}`],
  env: { ...env, ELECTRON_START_URL: 'http://127.0.0.1:5197' },
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}
const settle = () => page.waitForTimeout(250);

await page.waitForSelector('[data-testid=palette]');
await page.evaluate(async () => {
  const [{ host, read }, { useSession }, { layout }, { palette }] = await Promise.all([
    import('/src/host/index.ts'),
    import('/src/data/session.ts'),
    import('/src/layout/store.ts'),
    import('/src/shell/palette.ts'),
  ]);
  const channel = (id, kind, label) => ({ id, contentId: 1, channelId: Number(id.split(':')[1]), kind, label, title: label });
  useSession.setState({
    session: { contentId: 1, title: 'Test GP', status: 'replay' },
    channels: [channel('1:101', 'main', 'F1 LIVE'), channel('1:44', 'onboard', 'HAM'), channel('1:1', 'onboard', 'VER'), channel('1:4', 'onboard', 'NOR')],
  });
  host.layout.add({ items: [{ type: 'video', props: { feed: '1:101' } }] });
  const videos = (feeds) => feeds.map((feed) => ({ type: 'video', props: { feed } }));
  Object.assign(window, { host, read, layout, palette, videos });
});

const labels = () => page.evaluate(() => window.read().suggestions.items.map((i) => i.label));
const onScreen = () => page.evaluate(() => window.layout.tiles().map((t) => t.component.label));
const focused = () => page.evaluate(() => document.activeElement?.dataset.key ?? document.activeElement?.dataset.testid ?? null);

// The agent suggests: one new feed each, and one already on screen.
await page.evaluate(() => window.host.suggestions.offer({ items: window.videos(['1:44', '1:1', '1:101']) }));
await settle();
check('strip shows every suggestion', (await page.locator('[data-testid=suggestion]').count()) === 3);
check('the first suggestion has focus', (await focused()) === '1:44', String(await focused()));
check('one already on screen is marked', (await page.locator('[data-testid=suggestion][data-on-screen=true]').innerText()).includes('on screen'));
await page.screenshot({ path: path.join(outDir, 'suggestions-strip.png') });

await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
check('arrow keys move focus', (await focused()) === '1:101');
check(
  'focusing a duplicate outlines the tile it duplicates',
  await page.locator('.stage-host-highlight[data-tile-key="1:101"]').isVisible(),
);
await page.screenshot({ path: path.join(outDir, 'suggestions-duplicate.png') });
await page.keyboard.press('Enter');
await settle();
check('enter on a duplicate only takes it out of the strip', JSON.stringify(await labels()) === '["HAM","VER"]' && (await onScreen()).length === 1);
check('focus moves to the neighbour', (await focused()) === '1:1', String(await focused()));
check('the outline goes away', (await page.locator('.stage-host-highlight').count()) === 0);

await page.keyboard.press('h');
check('typing goes to the input', (await focused()) === 'palette-input' && (await page.locator('[data-testid=palette-input]').inputValue()) === 'h');
await page.keyboard.press('Backspace');
await page.keyboard.press('ArrowUp');
check('up from the empty input goes back to the strip', (await focused()) === '1:1', String(await focused()));
await page.keyboard.press('Enter');
await settle();
check('enter adds the suggestion', JSON.stringify(await onScreen()) === '["F1 LIVE","VER"]' && JSON.stringify(await labels()) === '["HAM"]');

// Drag HAM onto the left edge of the main tile.
const card = await page.locator('[data-testid=suggestion][data-key="1:44"]').boundingBox();
const grid = await page.locator('[data-testid=grid-surface]').boundingBox();
await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
await page.mouse.down();
await page.mouse.move(grid.x + 40, grid.y + grid.height / 2, { steps: 8 });
await settle();
check('dragging shows where it lands', await page.locator('[data-testid=drop-preview]').isVisible());
await page.screenshot({ path: path.join(outDir, 'suggestions-drag.png') });
await page.mouse.up();
await settle();
const ham = await page.evaluate(() => window.layout.tiles().find((t) => t.component.label === 'HAM'));
check('dropping adds it where it was dropped', ham != null && ham.x === 0, JSON.stringify(ham));
check('an empty strip closes', (await page.locator('[data-testid=suggestion-strip]').count()) === 0);
check('focus returns to the input', (await focused()) === 'palette-input');

// More in the same turn: what was added doesn't come back.
const again = await page.evaluate(() => window.host.suggestions.offer({ items: window.videos(['1:44', '1:4']) }));
await settle();
check('a repeat in the same turn is skipped', JSON.stringify(again.repeated) === '["HAM"]' && JSON.stringify(await labels()) === '["NOR"]');
await page.keyboard.press('Escape');
await settle();
check('esc dismisses the strip when the agent is idle', (await page.locator('[data-testid=suggestion-strip]').count()) === 0);
check('the palette stays open', await page.locator('[data-testid=palette-input]').isVisible());

// While the agent is working, it takes two.
await page.evaluate(() => {
  window.host.suggestions.newTurn();
  window.host.suggestions.offer({ items: window.videos(['1:4']) });
  window.palette.setBusy(true);
});
await settle();
await page.keyboard.press('Escape');
await settle();
check('one esc mid-turn only warns', (await labels()).length === 1 && (await page.locator('[data-testid=strip-hint]').innerText()).includes('esc again'));
await page.screenshot({ path: path.join(outDir, 'suggestions-armed.png') });
await page.keyboard.press('Escape');
await settle();
const busy = await page.evaluate(async () => (await import('/src/shell/palette.ts')).usePalette.getState().busy);
check('a second esc dismisses and stops the turn', (await labels()).length === 0 && !busy);

// Suggestions keep the palette from hiding.
await page.evaluate(() => {
  window.host.suggestions.newTurn();
  window.host.suggestions.offer({ items: window.videos(['1:4']) });
  window.palette.hide();
});
await settle();
check('the palette stays open while there are suggestions', await page.locator('[data-testid=suggestion-strip]').isVisible());

await app.close();
await server.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
