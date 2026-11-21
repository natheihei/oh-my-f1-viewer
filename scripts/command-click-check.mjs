// Clicking a command a palette line names runs it, in the real app: skipping onboarding says "/reset-onboarding
// brings it back", and clicking that brings it back. A "/settings-usage" in its error runs with the word after it,
// or alone. A command with a warning goes in the input instead of running. Runs in an OMFV of its own (see
// isolated.mjs), with no session open, so it prints no race information.
// Usage: node scripts/command-click-check.mjs <screenshot-dir>
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startIsolatedApp } from './isolated.mjs';
import { typeInPalette } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/command-click-check.mjs <screenshot-dir>');
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(path.resolve(outDir), { name: 'command-click', onboarding: true });
let failed = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failed += 1;
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const shoot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
/** Your own lines, as the history shows them. */
const yours = () => page.locator('.palette-user .palette-text').allInnerTexts();
/** The last command a line names with this text. */
const command = (text) => page.locator('[data-testid=palette-command]', { hasText: text }).last();

try {
  await page.waitForSelector('[data-testid=onboarding]', { timeout: 30_000 });
  await page.click('[data-testid=onboarding-skip]');
  await page.waitForSelector('[data-testid=onboarding]', { state: 'detached', timeout: 10_000 });
  const reset = command('/reset-onboarding');
  await reset.waitFor({ timeout: 10_000 });
  check('the skipped line names /reset-onboarding as a command', (await reset.count()) === 1);
  await reset.hover();
  await shoot('1-skipped-hover');
  await reset.click();
  await page.waitForSelector('[data-testid=onboarding]', { timeout: 10_000 });
  check('clicking it brings onboarding back', true);
  check('and echoes it as your line', (await yours()).at(-1) === '/reset-onboarding', JSON.stringify(await yours()));
  await shoot('2-onboarding-back');
  await page.click('[data-testid=onboarding-skip]');

  await typeInPalette(page, '/settings-usage maybe');
  await command('/settings-usage on').waitFor({ timeout: 10_000 });
  const names = await page.locator('.palette-error [data-testid=palette-command]').allInnerTexts();
  check('the usage error picks out each command with its word', JSON.stringify(names) === JSON.stringify(['/settings-usage on', '/settings-usage off', '/settings-usage']), JSON.stringify(names));
  await command('/settings-usage off').hover();
  await shoot('3-usage-error');
  // Alone, it only says how the counts stand.
  await page.locator('.palette-error [data-testid=palette-command]').nth(2).click();
  await page.waitForTimeout(1000);
  check('clicking /settings-usage alone runs it', (await yours()).at(-1) === '/settings-usage', JSON.stringify(await yours()));
  const last = await page.locator('.palette-line .palette-text').last().innerText();
  check('and it says how the counts stand', /^Usage counts are/.test(last), last);

  await page.evaluate(async () => {
    const { palette } = await import('/src/shell/palette.ts');
    palette.push('error', "Couldn't open the session: Sign in again with /login-f1tv.");
    palette.push('system', 'Try /build, with a session open.');
  });
  await command('/login-f1tv').hover();
  await shoot('4-error-line');
  await command('/build').click();
  const input = await page.locator('[data-testid=palette-input]').innerText();
  check('a command with a warning goes in the input instead', input.trim() === '/build', JSON.stringify(input));
  check('and runs nothing', !(await yours()).includes('/build'), JSON.stringify(await yours()));
  await shoot('5-build-in-input');
} catch (e) {
  failed += 1;
  log('FAIL', e.message);
  await shoot('error').catch(() => {});
} finally {
  await stop();
}
log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
