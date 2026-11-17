// Checks @ mentions in the palette's prompt in the real app, over a real replay race: the picker for a bare
// @, a number and a name, picking with Enter, Backspace on a tag giving back the @ text, Esc closing the
// picker, prose closing it, and the sent line keeping its tags in the history while the agent reads
// "HAM (#44)". Saves a screenshot at each step.
//
// Launched as scripts/codes-check.mjs is: through Hyprland on workspace 3, floating and without focus, with
// its own user data (the F1 TV and agent sign-ins copied in), and driven over CDP. Sending the line asks the
// real agent.
// Usage: node scripts/mentions-check.mjs <screenshot-dir> [race, by name] [--keep]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const keep = process.argv.includes('--keep');
const args = process.argv.filter((a) => a !== '--keep');
const outDir = args[2];
const raceName = args[3] ?? '';
if (!outDir) throw new Error('Usage: node scripts/mentions-check.mjs <screenshot-dir> [race]');
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(process.env.OMFV_SCRATCH ?? tmpdir(), 'omfv-mentions-'));
for (const f of ['omfv-session.json', 'omfv-cookies.json', 'omfv-ai-credentials.json']) copyFileSync(path.join(homedir(), '.config/oh-my-f1-viewer', f), path.join(userData, f));

const PORT = 5233;
const CDP = 9373;
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const electronBin = path.resolve('node_modules/electron/dist/electron');
const cmd = `env -u CHROME_DESKTOP ELECTRON_START_URL=http://127.0.0.1:${PORT} ${electronBin} ${path.resolve('.')} --user-data-dir=${userData} --remote-debugging-port=${CDP}`;
execFileSync('hyprctl', ['eval', `hl.exec_cmd(${JSON.stringify(cmd)}, { workspace = "3 silent", float = true, size = "1600 900", no_initial_focus = true })`]);
let browser;
for (let i = 0; i < 120 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null);
  if (!browser) await new Promise((r) => setTimeout(r, 500));
}
if (!browser) throw new Error('the app did not open its debugging port');
let page;
for (let i = 0; i < 120 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${PORT}`));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
// A hidden workspace stops producing frames once nothing moves: a tiny animation keeps screenshots working.
await page.addStyleTag({ content: '@keyframes omfv-tick{to{opacity:.99}} body::after{content:"";position:fixed;width:1px;height:1px;animation:omfv-tick 1s infinite alternate}' });

const done = async (code = 0) => {
  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close()).catch(() => {});
  await browser.close().catch(() => {});
  try {
    execFileSync('pkill', ['-f', '--', `user-data-dir=${userData}`]);
  } catch {}
  await server.close();
  process.exit(code);
};
for (const event of ['unhandledRejection', 'uncaughtException'])
  process.on(event, async (e) => {
    console.log('FAIL', e);
    await done(1);
  });

const opened = await page.evaluate(async (raceName) => {
  const { host, read } = await import('/src/host/index.ts');
  if (!(await host.account.status()).f1tv.signedIn) return { error: 'F1 TV is not signed in' };
  host.audio.setVolume({ volume: 0 });
  const events = (await host.catalog.events({ year: 2026 })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
  let race = null;
  for (const e of events) {
    race = (await host.catalog.sessions({ pageId: e.pageId, year: 2026 })).find((s) => s.type === 'race' && `${e.name} ${e.shortName} ${s.title}`.toLowerCase().includes(raceName.toLowerCase()));
    if (race) break;
  }
  if (!race) return { error: `no replay race matching "${raceName}"` };
  await host.session.open({ contentId: race.contentId, title: race.title });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
  host.layout.add({ items: [{ type: 'timing_tower', props: {} }] });
  host.layout.autoLayout();
  return { title: race.title };
}, raceName);
if (opened.error) {
  console.log('FAIL', opened.error);
  await done(1);
}
console.log(`opened ${opened.title}`);

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};
const input = page.locator('[data-testid=palette-input]');
/** The prompt as the box holds it: text, and each tag as [code]. */
const prompt = () =>
  page.evaluate(() =>
    [...document.querySelector('[data-testid=palette-input]').childNodes]
      .map((n) => (n.nodeType === 3 ? n.data : n.dataset?.mentionKind ? `[${n.textContent}]` : n.textContent))
      .join(''),
  );
const rows = () => page.locator('[data-testid=mention-option]').allInnerTexts();
const pickerOpen = () => page.locator('[data-testid=mention-picker]').isVisible();
let shot = 0;
const snap = async (name) => {
  await page.waitForTimeout(300);
  const file = path.join(outDir, `${++shot}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  -> ${file}`);
};

if (!(await input.isVisible())) await page.keyboard.press('Control+Shift+P');
await input.click();
await page.keyboard.type('gap from @');
check('a bare @ offers the roster', (await rows()).length >= 20, `${(await rows()).length} rows`);
await snap('bare-at');

await page.keyboard.type('lew');
check('@lew finds Hamilton', (await rows()).length === 1 && (await rows())[0].includes('HAM'), JSON.stringify(await rows()));
await snap('lew');
await page.keyboard.press('Enter');
check('Enter puts the tag in', (await prompt()) === 'gap from [HAM] ', JSON.stringify(await prompt()));
check('the picker closes', !(await pickerOpen()));

await page.keyboard.type('to @1');
const ones = await rows();
check('@1 lists #1 first, then numbers that start with 1', ones.length > 1 && /#1$/.test(ones[0].trim()), JSON.stringify(ones));
await snap('number');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Tab');
const second = await prompt();
check('Tab picks too', /^gap from \[HAM\] to \[[A-Z]{3}\] $/.test(second), JSON.stringify(second));

await page.keyboard.press('Backspace');
await page.keyboard.press('Backspace');
check('Backspace on a tag gives back the @ text', (await prompt()) === 'gap from [HAM] to @1', JSON.stringify(await prompt()));
check('with the picker open again', await pickerOpen());
await snap('untagged');
await page.keyboard.press('Escape');
check('Esc closes the picker', !(await pickerOpen()));
check('and keeps the text', (await prompt()) === 'gap from [HAM] to @1');
await page.keyboard.press('Backspace');
await page.keyboard.type('nor');
check('editing the @ opens the picker again', await pickerOpen(), JSON.stringify(await rows()));
await page.keyboard.press('Enter');
await page.keyboard.type('and @max speed');
check('prose after an @ closes the picker', !(await pickerOpen()), JSON.stringify(await prompt()));
check('and stays text', (await prompt()) === 'gap from [HAM] to [NOR] and @max speed', JSON.stringify(await prompt()));
for (let i = 0; i < 'and @max speed'.length; i++) await page.keyboard.press('Backspace');
await snap('ready');

await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const sent = await page.evaluate(async () => {
  const { usePalette } = await import('/src/shell/palette.ts');
  const entry = usePalette.getState().entries.filter((e) => e.role === 'user').at(-1);
  const line = [...document.querySelectorAll('.palette-user .palette-text')].at(-1);
  return { text: entry?.text, codes: [...(line?.querySelectorAll('.driver-code') ?? [])].map((c) => c.textContent) };
});
check('the agent reads code and number', sent.text === 'gap from HAM (#44) to NOR (#1)', JSON.stringify(sent.text));
check('the history keeps the tags', sent.codes.join(',') === 'HAM,NOR', JSON.stringify(sent.codes));
check('the input is empty again', (await prompt()) === '');
await page.waitForTimeout(15_000);
await snap('sent');

console.log(failed ? `${failed} failed` : 'all passed');
if (keep) {
  console.log(`left open: user data in ${userData}. Serving it until the app is closed.`);
  page.on('close', () => done(0));
  browser.on('disconnected', () => done(0));
} else await done(failed ? 1 : 0);
