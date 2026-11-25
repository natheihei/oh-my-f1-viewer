// The landing page in the real app: onboarding has two steps and gives way to it, the tape opens on now with
// no row open unless a session is live, a row clicked writes its session into the input and opens to its
// suffixes, a suffix adds to the prompt, and the arrow keys walk the sessions. The palette isn't held open there:
// Esc and presses outside fold it, and a row clicked unfolds it. Nothing is sent, so no session opens. Runs in an OMFV of its own (see isolated.mjs). It prints session names from the calendar, never a result.
// Usage: node scripts/landing-check.mjs <screenshot-dir>
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startIsolatedApp } from './isolated.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/landing-check.mjs <screenshot-dir>');
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(path.resolve(outDir), { name: 'landing', onboarding: true });
let failed = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failed += 1;
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const shoot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const input = () => page.locator('[data-testid=palette-input]').innerText();
const rows = (status) => page.locator(`[data-testid=landing-row][data-status=${status}]`);

try {
  await page.waitForSelector('[data-testid=onboarding]', { timeout: 30_000 });
  check('onboarding has two steps', (await page.locator('.onboarding-step').count()) === 2);
  check('the landing page waits behind onboarding', (await page.locator('[data-testid=landing]').count()) === 0);
  await shoot('1-onboarding');
  await page.click('[data-testid=onboarding-skip]');
  await page.waitForSelector('[data-testid=landing-row]', { timeout: 60_000 });
  await page.waitForTimeout(500);

  const live = await rows('live').count();
  const chips = page.locator('[data-testid=landing-chips]');
  check(live ? 'a live session starts open' : 'no row starts open while nothing is live', (await chips.count()) === (live ? 1 : 0), `${live} live`);
  check('the input starts empty', (await input()).trim() === '', await input());
  const line = await page.evaluate(() => {
    const tape = document.querySelector('[data-testid=landing-tape]').getBoundingClientRect();
    const now = document.querySelector('[data-testid=landing-now]').getBoundingClientRect();
    return (now.top - tape.top) / tape.height;
  });
  check('it opens with the line at now in view', line > 0 && line < 1, line.toFixed(2));
  log(`${await rows('upcoming').count()} upcoming, ${live} live, ${await rows('past').count()} finished`);
  await shoot('2-landing');

  // The last race finished: the first one under the line.
  const race = page.locator('[data-testid=landing-row][data-status=past][data-kind=race]').first();
  await race.click();
  const named = (await input()).trim();
  check('a row clicked writes its session in the input', /^20\d\d .+ (race|sprint)$/.test(named), named);
  check('and opens to its suffixes', (await chips.count()) === 1 && (await page.locator('[data-testid=landing-chip]').count()) >= 3);
  check('the input has the keyboard', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'palette-input'));

  await page.locator('[data-testid=landing-chip]', { hasText: 'lights out' }).click();
  await page.locator('[data-testid=landing-chip]', { hasText: 'top 3' }).click();
  const whole = (await input()).trim();
  check('suffixes add to the prompt', whole === `${named}, jump to 30 seconds before lights out, with onboards of the top 3 on the grid`, whole);
  await shoot('3-picked');

  await page.keyboard.press('ArrowDown');
  const before = (await input()).trim();
  check('arrow down picks the session before it', before !== whole && /^20\d\d /.test(before), before);
  await page.keyboard.press('ArrowUp');
  check('arrow up comes back, without the suffixes that did not fit the one before', (await input()).trim() === named, await input());

  await page.locator('[data-testid=palette-input]').fill('something of my own');
  await page.keyboard.press('ArrowUp');
  check("the arrows leave the viewer's own text alone", (await input()).trim() === 'something of my own', await input());

  // The landing page is something on screen, so the palette isn't held: Esc and presses outside hide it.
  const folded = page.locator('[data-testid=palette-folded]');
  await page.keyboard.press('Escape');
  check('Esc clears the input first', (await input()).trim() === '', await input());
  await page.keyboard.press('Escape');
  check('then Esc folds the palette', (await folded.count()) === 1);
  // Unfolded, the palette puts the keyboard in its input, again a frame later, which a viewer's next press comes
  // after. On a hidden workspace frames come slowly, so this waits for that one.
  const inInput = async () => {
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'palette-input', null, { timeout: 5_000 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  await folded.click();
  await inInput();
  check('a click on the folded palette unfolds it', (await folded.count()) === 0 && (await page.locator('[data-testid=palette-input]').count()) === 1);
  // A press on the landing page where nothing takes focus, away from the palette and its rows.
  const spot = await page.evaluate(() => {
    const box = document.querySelector('[data-testid=landing]').getBoundingClientRect();
    for (let y = box.top + 4; y < box.bottom; y += 8) {
      for (const x of [box.left + 4, box.right - 4]) {
        const at = document.elementFromPoint(x, y);
        if (at && !at.closest('button, a, input, [contenteditable], [data-testid=palette]')) return { x, y };
      }
    }
    return null;
  });
  check('there is a spot on the landing page with nothing to press', spot != null);
  if (spot) {
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(3_500);
    check('a press outside folds it 3 seconds later', (await folded.count()) === 1);
    const says = await folded.innerText();
    check('folded, it says what it is for there', says.includes('name a session'), says);
    await shoot('4-folded');
    await folded.click();
    await inInput();
    await page.mouse.click(spot.x, spot.y);
    await page.locator('[data-testid=landing-jump-now]').click();
    check('a second press outside folds it at once', (await folded.count()) === 1);
  }
  await page.waitForTimeout(500);
  await race.click();
  check('a row clicked while it is folded unfolds it with the session in the input', (await folded.count()) === 0 && (await input()).trim().startsWith(named), await input());
  check('with the keyboard in the input', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'palette-input'));
} finally {
  await stop();
}
log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
