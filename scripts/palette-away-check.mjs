// Exercises when the palette hides itself and what's unread, in an OMFV of its own (see isolated.mjs), without any
// sign-in: a session with channels but no streams, and the agent's replies, suggestions and spoiler check made the
// way the feed and the tools make them. See docs/ARCHITECTURE.md (When the palette hides, and what's unread).
// Usage: node scripts/palette-away-check.mjs [screenshot-dir]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startIsolatedApp } from './isolated.mjs';

const outDir = path.resolve(process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'omfv-palette-away-')));
mkdirSync(outDir, { recursive: true });
const { page, stop } = await startIsolatedApp(outDir, { name: 'palette-away', scale: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}
const settle = () => page.waitForTimeout(250);
/** Just over the palette's AWAY_HIDE_MS. */
const AWAY = 3_300;

await page.waitForSelector('[data-testid=palette]');
await page.evaluate(async () => {
  const [{ host, read }, { useSession }, { palette, usePalette }, { askViewer, lookAhead }] = await Promise.all([
    import('/src/host/index.ts'),
    import('/src/data/session.ts'),
    import('/src/shell/palette.ts'),
    import('/src/shell/lookAhead.ts'),
  ]);
  const channel = (id, kind, label) => ({ id, contentId: 1, channelId: Number(id.split(':')[1]), kind, label, title: label });
  useSession.setState({
    session: { contentId: 1, title: 'Test GP', status: 'replay' },
    channels: [channel('1:101', 'main', 'F1 LIVE'), channel('1:44', 'onboard', 'HAM'), channel('1:4', 'onboard', 'NOR')],
  });
  host.layout.add({ items: [{ type: 'video', props: { feed: '1:101' } }] });
  /** A reply as the agent's feed draws one, streamed in two parts, with `between` run after the first. */
  const reply = async (text, between = async () => {}) => {
    palette.setBusy(true);
    const id = palette.push('agent', '');
    palette.append(id, text.slice(0, 10));
    await between();
    palette.append(id, text.slice(10));
  };
  Object.assign(window, { host, read, palette, usePalette, askViewer, lookAhead, reply });
});

const open = () => page.locator('[data-testid=palette]').isVisible();
const folded = () => page.locator('[data-testid=palette-folded]').isVisible();
const unread = () => page.evaluate(() => window.usePalette.getState().unread);
const inPalette = () => page.evaluate(() => document.querySelector('[data-testid=palette]')?.contains(document.activeElement) ?? false);
const focused = () => page.evaluate(() => document.activeElement?.dataset.key ?? document.activeElement?.dataset.testid ?? document.activeElement?.tagName);
/** A press on the main video, where nothing takes focus. */
const pressVideo = async () => {
  const box = await page.locator('[data-testid=stage]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
};

await page.locator('[data-testid=palette-input]').click();
await page.evaluate(() => window.reply('Norris is 1.2s behind Hamilton.').then(() => window.palette.setBusy(false)));
await page.waitForTimeout(4_000);
check('a reply with the viewer in the palette stays, and is read', (await open()) && !(await unread()));

await page.locator('.palette-history .palette-line').last().click();
await page.waitForTimeout(AWAY);
check('a press on the history keeps it, though focus goes nowhere', await open());

await page.locator('[data-testid=palette-input]').click();
await pressVideo();
await page.waitForTimeout(2_000);
check('a press on the video leaves it a moment', await open());
await page.waitForTimeout(AWAY - 2_000);
check('and hides it 3s after', await folded());

await page.evaluate(() => window.reply('Hamilton pits this lap, by the gap.').then(() => window.palette.setBusy(false)));
await settle();
check('a reply while it is hidden is unread', await unread());
check('folded, it is marked', (await page.locator('[data-testid=palette-folded]').getAttribute('data-unread')) === 'true');
check('folded, it says the reply', /Hamilton pits/.test(await page.locator('[data-testid=palette-folded-line]').innerText()));
await page.screenshot({ path: path.join(outDir, 'palette-away-folded-unread.png') });

await page.locator('[data-testid=palette-folded]').click();
await settle();
check('a click brings the viewer back, and reads it', (await open()) && !(await unread()) && (await focused()) === 'palette-input', String(await focused()));
await page.screenshot({ path: path.join(outDir, 'palette-away-read.png') });

// Moving away mid-reply hides it all the same, and the rest of the reply is unread.
await page.evaluate(() => window.reply('Leclerc has the fastest lap.', async () => {}));
await pressVideo();
await page.evaluate(() => window.palette.append(window.usePalette.getState().entries.at(-1).id, ' Again.'));
await page.waitForTimeout(AWAY);
check('it hides while the agent is still working', (await folded()) && (await page.evaluate(() => window.usePalette.getState().busy)));
check('what came after the viewer left is unread', await unread());
await page.evaluate(() => window.palette.setBusy(false));

// Suggestions from elsewhere show, unread, and don't take focus. The palette's key takes the viewer to them.
await page.evaluate(() => {
  window.host.suggestions.newTurn();
  window.host.suggestions.offer({ items: [{ type: 'video', props: { feed: '1:44' } }, { type: 'video', props: { feed: '1:4' } }] });
});
await settle();
check('suggestions from elsewhere show the palette', await page.locator('[data-testid=suggestion-strip]').isVisible());
check('and leave focus where it was', !(await inPalette()), String(await focused()));
check('and are unread', (await unread()) && (await page.locator('[data-testid=palette]').getAttribute('data-unread')) === 'true');
await page.screenshot({ path: path.join(outDir, 'palette-away-suggestions-unread.png') });
await page.keyboard.press('Control+K');
await settle();
check("the palette's key takes the viewer to the first suggestion", (await focused()) === '1:44' && !(await unread()), String(await focused()));
await page.keyboard.press('Escape');
await settle();
check('esc dismisses them, and the palette stays', (await page.locator('[data-testid=suggestion-strip]').count()) === 0 && (await open()));

// The hold ending while the viewer is away starts the time.
await page.evaluate(() => {
  window.host.suggestions.newTurn();
  window.host.suggestions.offer({ items: [{ type: 'video', props: { feed: '1:44' } }] });
});
await settle();
await pressVideo();
await page.waitForTimeout(AWAY);
check('suggestions hold it while the viewer is away', await open());
await page.evaluate(() => window.host.suggestions.dismiss());
await page.waitForTimeout(AWAY);
check('and it hides 3s after they go', await folded());

// The spoiler check from elsewhere: shown, unread, no focus taken.
await page.evaluate(() => {
  window.checkAnswer = window.askViewer({}, new AbortController().signal);
});
await settle();
check('a spoiler check from elsewhere shows', await page.locator('[data-testid=palette]').isVisible());
check('and leaves focus where it was', !(await inPalette()), String(await focused()));
check('and is unread', await unread());
await page.screenshot({ path: path.join(outDir, 'palette-away-spoiler-unread.png') });
await page.keyboard.press('Control+K');
await settle();
check("the palette's key takes the viewer to the spoiler check", (await focused()) === 'spoiler-once' && !(await unread()), String(await focused()));
await page.keyboard.press('Escape');
const decision = await page.evaluate(() => window.checkAnswer);
check('and Esc there answers it', decision.approved === false);
await settle();
check('answered, focus goes back to the input', (await focused()) === 'palette-input', String(await focused()));

// In the palette, the key and Esc put it away.
await page.keyboard.press('Escape');
await settle();
check('esc in the input hides it', await folded());

await stop();
console.log(failures ? `\n${failures} failed` : '\nall passed');
console.log(`screenshots in ${outDir}`);
process.exit(failures ? 1 : 0);
