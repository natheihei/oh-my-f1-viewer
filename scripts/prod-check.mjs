// Runs the production build (its CSP, file:// origin, no dev server) through the parts of the shell
// the journey doesn't reach: countdown, timeline mouse and keyboard, volume. Needs both sign-ins.
// Usage: npm run build && node scripts/prod-check.mjs [screenshot-dir]
import path from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from './launch.mjs';

const outDir = process.argv[2] ?? tmpdir();
const { app, page } = await launch();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 240));
  if (/Content Security Policy|Refused to/.test(m.text())) console.log('[CSP]', m.text().slice(0, 240));
});
page.on('pageerror', (e) => errors.push(e.message));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const input = page.locator('[data-testid=palette-input]');
const palette = page.locator('[data-testid=palette]');
const history = page.locator('[data-testid=palette-history]');
const replies = () => history.locator('.palette-agent, .palette-error').count();

async function say(text) {
  if (!(await input.isVisible())) await page.keyboard.press('Control+K');
  const before = await replies();
  await input.fill(text);
  await input.press('Enter');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const busy = await page.locator('.palette-prompt-busy').count().catch(() => 0);
    if ((await replies()) > before && !busy) break;
    if (!(await palette.isVisible())) break;
    await page.waitForTimeout(250);
  }
  const reply = (await history.locator('.palette-agent, .palette-error').last().innerText().catch(() => '')) || '';
  console.log(`> ${text}\n  ${reply.slice(0, 150)}`);
  return reply;
}

await page.waitForSelector('[data-testid=palette]');
await page.waitForTimeout(2000);

// Countdown
await say('Count down to the next practice session, that is the one I want.');
await page.waitForTimeout(1500);
const countdown = page.locator('[data-testid=countdown]');
check('countdown shows', await countdown.isVisible());
if (await countdown.isVisible()) {
  const first = await countdown.innerText();
  await page.waitForTimeout(2100);
  const second = await countdown.innerText();
  console.log('  ', first.replace(/\n/g, ' | '));
  check('countdown ticks', first !== second);
  await page.screenshot({ path: path.join(outDir, 'prod-countdown.png') });
}

// Replay in the production build
await say('2025 Mexico qualifying');
const timeline = page.locator('[data-testid=timeline]');
await timeline.waitFor({ timeout: 20_000 });
check('countdown goes away when a session opens', !(await countdown.isVisible()));
const video = page.locator('video.stream-video').first();
const playing = async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const t = await video.evaluate((v) => ({ t: v.currentTime, r: v.readyState, f: v.getVideoPlaybackQuality().totalVideoFrames }));
    if (t.f > 30 && t.r >= 3) return t;
    await page.waitForTimeout(500);
  }
  return null;
};
const started = await playing();
check('video decodes under the production CSP', !!started, JSON.stringify(started));

// Mouse seek
await page.waitForTimeout(3000); // let the palette hide
const box = await page.locator('[data-testid=timeline-bar]').boundingBox();
await page.mouse.click(box.x + box.width * 0.05, box.y + box.height / 2);
await page.waitForTimeout(6000);
const span = await video.evaluate((v) => v.duration);
const afterSeek = await video.evaluate((v) => v.currentTime);
check('clicking the timeline seeks', Math.abs(afterSeek - span * 0.05) < 15, `at ${afterSeek.toFixed(1)}, expected about ${(span * 0.05).toFixed(1)}`);
await page.screenshot({ path: path.join(outDir, 'prod-playing.png') });

// Keyboard
await page.mouse.click(5, 5); // focus off the palette
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const paused = await video.evaluate((v) => v.paused);
check('Space pauses', paused);
const pausedAt = await video.evaluate((v) => v.currentTime);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1200);
const stepped = await video.evaluate((v) => v.currentTime);
check('Right arrow steps forward 10s', Math.abs(stepped - pausedAt - 10) < 1.5, `${pausedAt.toFixed(1)} -> ${stepped.toFixed(1)}`);
await page.keyboard.press('Space');
await page.waitForTimeout(800);
check('Space resumes', !(await video.evaluate((v) => v.paused)));

// Volume
const volumeOf = () => video.evaluate((v) => v.volume);
const slider = await page.locator('[data-testid=timeline-volume]').boundingBox();
await page.mouse.click(slider.x + slider.width * 0.5, slider.y + slider.height / 2);
await page.waitForTimeout(200);
const halfway = await volumeOf();
check('the slider sets the volume', Math.abs(halfway - 0.5) < 0.05, `at ${halfway}`);
const audibleBefore = await video.evaluate((v) => v.muted);
await page.keyboard.press('ArrowUp');
await page.waitForTimeout(100);
check('Up arrow raises the volume after using the slider', Math.abs((await volumeOf()) - halfway - 0.05) < 0.001);
await page.keyboard.press('m');
await page.waitForTimeout(100);
check('M mutes', (await volumeOf()) === 0);
check('muting leaves the audible feed alone', (await video.evaluate((v) => v.muted)) === audibleBefore);
await page.locator('[data-testid=timeline-mute]').click();
await page.waitForTimeout(100);
check('the icon restores the volume', Math.abs((await volumeOf()) - halfway - 0.05) < 0.001);
const beforeSpace = await video.evaluate((v) => v.paused);
await page.keyboard.press('Space');
await page.waitForTimeout(500);
check('Space still toggles play after the volume control', (await video.evaluate((v) => v.paused)) !== beforeSpace);
await page.keyboard.press('Space');
await page.waitForTimeout(500);

// Palette
const wasOpen = await palette.isVisible();
await page.keyboard.press('Control+K');
await page.waitForTimeout(200);
check('Ctrl+K toggles the palette', (await palette.isVisible()) !== wasOpen);
if (!(await palette.isVisible())) await page.keyboard.press('Control+K');
await page.waitForTimeout(200);
await input.press('Escape');
await page.waitForTimeout(200);
check('Escape hides the palette', !(await palette.isVisible()));
await page.keyboard.press('Control+K');
await page.waitForTimeout(200);
check('history is still there on reopening', (await history.locator('.palette-line').count()) > 2);
const scrolls = await history.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, top: el.scrollTop }));
check('history box stays short and scrolls', scrolls.clientHeight < 200 && scrolls.scrollHeight >= scrolls.clientHeight, JSON.stringify(scrolls));
await page.screenshot({ path: path.join(outDir, 'prod-palette.png') });

if (errors.length) console.log('console errors:\n  ' + [...new Set(errors)].slice(0, 8).join('\n  '));
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await app.close();
process.exit(failures ? 1 : 0);
