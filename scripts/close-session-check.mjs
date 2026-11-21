// Leaves an open replay race for the screen with nothing open, in an OMFV of its own (see isolated.mjs): the
// timeline's ×, then /close-session typed in the palette, then "stop waiting" under a countdown. Each goes
// back to the landing page with no tiles and no timeline, and an "Allow for this session" ends with the
// session. Sends nothing to the agent. Needs the F1 TV login.
// Usage: node scripts/close-session-check.mjs [screenshot-dir]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRace, startIsolatedApp } from './isolated.mjs';

const outDir = path.resolve(process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'omfv-close-session-')));
mkdirSync(outDir, { recursive: true });
const { page, stop } = await startIsolatedApp(outDir, { name: 'close-session', scale: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}
const settle = () => page.waitForTimeout(1000);

/** What's on screen: whether a session is open, its tiles, and what of home shows. */
const screen = () =>
  page.evaluate(async () => {
    const [{ read }, { useLookAhead }, { usePalette }] = await Promise.all([
      import('/src/host/index.ts'),
      import('/src/shell/lookAhead.ts'),
      import('/src/shell/palette.ts'),
    ]);
    const live = read();
    return {
      session: live.session?.title ?? null,
      countdown: live.countdown?.title ?? null,
      tiles: live.layout.tiles.length,
      timeline: document.querySelector('[data-testid=timeline]') != null,
      landing: document.querySelector('[data-testid=landing]') != null,
      hasSession: document.querySelector('.app')?.getAttribute('data-has-session'),
      allowed: useLookAhead.getState().sessionAllowed,
      last: usePalette.getState().entries.at(-1)?.text ?? null,
    };
  });

/** Home as the app starts with nothing open, once onboarding is over. */
function checkHome(how, s, line) {
  check(`${how}: no session is open`, s.session == null && s.countdown == null && s.hasSession === 'false', JSON.stringify(s));
  check(`${how}: no tiles and no timeline`, s.tiles === 0 && !s.timeline);
  check(`${how}: the landing page shows`, s.landing);
  check(`${how}: the palette says what closed`, s.last === line, s.last);
}

try {
  await page.waitForSelector('[data-testid=palette]');
  // The landing page waits for onboarding to be over, as it is once someone has opened a session.
  await page.evaluate(async () => (await import('/src/shell/onboardingState.ts')).onboarding.finish('done'));

  let race = await openRace(page);
  console.log(`opened ${race.title}`);
  await page.evaluate(async () => {
    const [{ read }, { useLookAhead }] = await Promise.all([import('/src/host/index.ts'), import('/src/shell/lookAhead.ts')]);
    useLookAhead.setState({ sessionAllowed: read().session.contentId });
  });
  await settle();
  let s = await screen();
  check('the race is open with its timeline', s.session === race.title && s.timeline && s.tiles > 0, JSON.stringify(s));
  await page.screenshot({ path: path.join(outDir, '0-open.png') });

  await page.locator('[data-testid=timeline-close]').click();
  await settle();
  s = await screen();
  checkHome('the timeline ×', s, `Closed ${race.title}.`);
  check('"Allow for this session" ends with the session', s.allowed == null, String(s.allowed));
  await page.screenshot({ path: path.join(outDir, '1-closed-by-button.png') });

  race = await openRace(page);
  await settle();
  check('the race opens again', (await screen()).session === race.title);
  const input = page.locator('[data-testid=palette-input]');
  await input.click();
  await page.keyboard.type('/close-session');
  await settle();
  await page.screenshot({ path: path.join(outDir, '2-typed-command.png') });
  await page.keyboard.press('Enter');
  await settle();
  s = await screen();
  checkHome('/close-session', s, `Closed ${race.title}.`);
  await page.screenshot({ path: path.join(outDir, '3-closed-by-command.png') });

  // A countdown, without waiting for one: the state the countdown starts with.
  await page.evaluate(async () => {
    const { useCountdown } = await import('/src/host/viewing.ts');
    useCountdown.setState({ countdown: { title: 'Check Race', startMs: Date.now() + 3_600_000, session: { contentId: 1, title: 'Check Race' } } });
  });
  await settle();
  check('the countdown shows instead of the landing page', !(await screen()).landing && (await page.locator('[data-testid=countdown]').count()) === 1);
  await page.screenshot({ path: path.join(outDir, '4-countdown.png') });
  await page.locator('[data-testid=countdown-close]').click();
  await settle();
  s = await screen();
  checkHome('"stop waiting"', s, 'Stopped the countdown to Check Race.');
  await page.screenshot({ path: path.join(outDir, '5-countdown-stopped.png') });
} finally {
  await stop();
}
console.log(failures ? `${failures} failed` : 'all passed', `screenshots in ${outDir}`);
process.exit(failures ? 1 : 0);
