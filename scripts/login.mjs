// Runs F1 TV sign-in and the agent's setup through the palette, skipping any that are already done. It runs on the
// main profile, ~/.config/oh-my-f1-viewer, since that's where the checks copy both logins from: close OMFV first.
import { paletteText, startApp, typeInPalette } from './harness.mjs';
import { MAIN_PROFILE } from './isolated.mjs';

const { page, stop } = await startApp(undefined, { userData: MAIN_PROFILE });
const status = () => page.evaluate(async () => ({ f1: await window.omfv.f1tv.status(), ai: await window.omfv.ai.status() }));
console.log('before:', JSON.stringify(await status()));

/** Waits on the login itself rather than palette text, which a reload would clear. */
async function waitFor(check, failed, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check(await status())) return true;
    const text = await paletteText(page);
    if (failed.test(text)) {
      console.log('failed:', text.match(new RegExp(`.*${failed.source}.*`))?.[0]);
      return false;
    }
    await page.waitForTimeout(1000);
  }
  console.log('timed out');
  return false;
}

const FIVE_MINUTES = 5 * 60_000 + 10_000;
await page.waitForTimeout(1500);
if (!(await status()).f1.signedIn) {
  await typeInPalette(page, '/login-f1tv');
  console.log('F1 TV sign-in window should be open');
  await waitFor((s) => s.f1.signedIn, /F1 TV sign-in failed/, FIVE_MINUTES);
}
if (!(await status()).ai.ready) {
  await typeInPalette(page, '/settings-agent');
  console.log('Connect a provider in the agent panel that just opened');
  await waitFor((s) => s.ai.ready, /Couldn't connect/, FIVE_MINUTES);
}
console.log('palette:\n' + (await paletteText(page)));
console.log('after:', JSON.stringify(await status()));
await stop();
process.exit(0);
