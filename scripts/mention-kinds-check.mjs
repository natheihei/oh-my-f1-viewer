// Checks mentioning tiles on screen and teams in the palette's prompt, in the real app over a real replay race:
// the bare @ grouped as on screen, drivers and teams; the selected tile row outlining its tile; picking a tile
// and a team; a driver's code ranking above the tile that names them; a tile's tag outlining its tile under
// the mouse and going dashed once the tile closes; what the agent reads; and no picker with no session.
// Saves a screenshot at each step.
//
// Runs an isolated f1a (scripts/isolated.mjs). Sending the line goes to the agent, which may not be signed in
// on the fresh profile: only the line as sent is checked.
// Usage: node scripts/mention-kinds-check.mjs <screenshot-dir> [--keep]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openRace, startIsolatedApp } from './isolated.mjs';

const keep = process.argv.includes('--keep');
const outDir = process.argv.filter((a) => a !== '--keep')[2];
if (!outDir) throw new Error('Usage: node scripts/mention-kinds-check.mjs <screenshot-dir> [--keep]');
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(path.resolve(outDir), { name: 'mention-kinds' });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};
const finish = async () => {
  log(failed ? `${failed} failed` : 'all passed');
  if (!keep) await stop();
  process.exit(failed ? 1 : 0);
};
for (const event of ['unhandledRejection', 'uncaughtException'])
  process.on(event, async (e) => {
    log('FAIL', e);
    failed++;
    await finish();
  });

const race = await openRace(page);
log(`opened ${race.title}`);

// The tiles: the main feed opened with the session, plus an onboard, a gap chart and the tower.
const setup = await page.evaluate(async () => {
  const { host, read } = await import('/src/host/index.ts');
  const onboard = read().feeds.find((f) => f.kind === 'onboard' && f.number != null);
  const [a, b] = read().sessionData.drivers.map((d) => d.driver_number);
  host.layout.add({
    items: [
      { type: 'video', props: { feed: onboard.id } },
      { type: 'gap_evolution', props: { driver_a: a, driver_b: b } },
      { type: 'timing_tower', props: {} },
    ],
  });
  host.layout.autoLayout();
  const tiles = read().layout.tiles.map((t) => ({ id: t.id, label: t.component.label }));
  return { tiles, onboard: { number: onboard.number } };
});
log('tiles', JSON.stringify(setup.tiles));
const onboardCode = await page.evaluate(async (n) => (await import('/src/host/index.ts')).codeOf(n), setup.onboard.number);
const onboardTile = await page.evaluate(
  async (number) => (await import('/src/host/index.ts')).read().layout.tiles.find((t) => t.component.title?.drivers?.[0] === number)?.id,
  setup.onboard.number,
);
const gapTile = setup.tiles.find((t) => t.label.startsWith('Gap'))?.id;
await page.waitForTimeout(3000);

const input = page.locator('[data-testid=palette-input]');
const rows = () => page.locator('[data-testid=mention-option]').allInnerTexts();
const groups = () => page.locator('[data-testid=mention-group]').allTextContents();
const pickerOpen = () => page.locator('[data-testid=mention-picker]').isVisible();
const pointed = () => page.evaluate(async () => (await import('/src/host/index.ts')).read().pointed);
const outlined = () => page.evaluate(() => document.querySelectorAll('.stage-host-highlight').length);
/** The prompt as the box holds it: text, and each tag as [kind:text]. */
const prompt = () =>
  page.evaluate(() =>
    [...document.querySelector('[data-testid=palette-input]').childNodes]
      .map((n) => (n.nodeType === 3 ? n.data : n.dataset?.mentionKind ? `[${n.dataset.mentionKind}:${n.textContent}]` : n.textContent))
      .join('')
      .replace(/ /g, ' '),
  );
let shot = 0;
const snap = async (name) => {
  await page.waitForTimeout(400);
  const file = path.join(outDir, `${String(++shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  log(`  -> ${file}`);
};

if (!(await input.isVisible())) await page.keyboard.press('Control+Shift+P');
await input.click();

// A bare @: grouped, tiles first, the first tile outlined.
await page.keyboard.type('compare @');
check('a bare @ heads on screen, drivers, teams', JSON.stringify(await groups()) === JSON.stringify(['On screen', 'Drivers', 'Teams']), JSON.stringify(await groups()));
const bare = await rows();
check('every tile, driver and team is a row', bare.length >= setup.tiles.length + 20 + 10, `${bare.length} rows`);
check('the selected tile is outlined', (await pointed()) === setup.tiles[0].id && (await outlined()) === 1, `${await pointed()}`);
await snap('bare-at');
await page.keyboard.press('ArrowDown');
check('↓ moves the outline to the next tile', (await pointed()) === setup.tiles[1].id, `${await pointed()}`);
await snap('bare-at-down');

// A tile by a word of its label.
await page.keyboard.type('gap');
const gaps = await rows();
check('@gap finds the gap tile first, on screen', /gap/i.test(gaps[0] ?? '') && /on screen/.test(gaps[0] ?? ''), JSON.stringify(gaps));
check('no headings for a typed query', (await groups()).length === 0);
check('it is outlined', (await pointed()) === gapTile);
await page.keyboard.press('Enter');
check('Enter puts the tile tag in', /^compare \[tile:Gap[^\]]*\] $/.test(await prompt()), JSON.stringify(await prompt()));
check('closing the picker clears the outline', (await pointed()) === null);

// A team. "fer" also starts Fernando; as good a match, the driver keeps the kinds' order and comes first.
await page.keyboard.type('with @fer');
const teams = await rows();
const ferrari = teams.findIndex((r) => /^FERRARI\n/i.test(r));
check('@fer finds Ferrari', ferrari >= 0, JSON.stringify(teams));
for (let i = 0; i < ferrari; i++) await page.keyboard.press('ArrowDown');
await snap('team');
await page.keyboard.press('Enter');
check('Enter puts the team tag in', /\[team:Ferrari\] $/.test(await prompt()), JSON.stringify(await prompt()));

// A driver's code ranks above the onboard that names them; ↓ picks the onboard.
await page.keyboard.type(`and @${onboardCode.toLowerCase()}`);
const both = await rows();
check(`@${onboardCode.toLowerCase()} lists the driver, then the onboard`, both.length >= 2 && !/on screen/.test(both[0]) && /on screen/.test(both[1]), JSON.stringify(both));
await page.keyboard.press('ArrowDown');
check('↓ onto the onboard outlines it', (await pointed()) === onboardTile, `${await pointed()} vs ${onboardTile}`);
await snap('driver-or-tile');
await page.keyboard.press('Enter');
check('the onboard tag is in', (await prompt()).includes(`[tile:${onboardCode}]`), JSON.stringify(await prompt()));

// Hovering a tile tag in the prompt outlines it.
await page.locator(`[data-testid=palette-input] [data-tile="${gapTile}"]`).hover();
check('hovering a tile tag outlines its tile', (await pointed()) === gapTile && (await outlined()) === 1);
await snap('hover-prompt-tag');
await page.mouse.move(5, 5);
check('leaving it clears the outline', (await pointed()) === null);

// The onboard closes while its tag is in the prompt.
await page.evaluate(async (id) => (await import('/src/host/index.ts')).host.layout.remove({ tiles: [id] }), onboardTile);
await page.waitForTimeout(300);
const gone = await page.evaluate((id) => document.querySelector(`[data-testid=palette-input] [data-tile="${id}"]`)?.classList.contains('tile-tag-gone'), onboardTile);
check('a closed tile’s tag goes dashed in the prompt', gone === true);
await snap('closed-in-prompt');

// What the agent reads.
await input.click();
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
const sent = await page.evaluate(async () => {
  const { usePalette } = await import('/src/shell/palette.ts');
  return usePalette.getState().entries.filter((e) => e.role === 'user').at(-1)?.text;
});
log('sent:', sent);
check('the agent reads the tile by label and id', new RegExp(`tile "Gap[^"]*" \\(${gapTile}\\)`).test(sent ?? ''), sent);
check('the agent reads the team with its drivers', /team Ferrari \([A-Z]{3} #\d+, [A-Z]{3} #\d+\)/.test(sent ?? ''), sent);
check('the agent reads the closed tile as closed', sent?.includes(`(${onboardTile}, closed)`), sent);
const history = await page.evaluate(() => {
  const line = [...document.querySelectorAll('.palette-user .palette-text')].at(-1);
  return { tiles: line?.querySelectorAll('.tile-tag').length, gone: line?.querySelectorAll('.tile-tag-gone').length, teams: line?.querySelectorAll('.team-tag').length };
});
check('the history keeps the tags', history.tiles === 2 && history.gone === 1 && history.teams === 1, JSON.stringify(history));
await page.locator(`.palette-user .palette-text [data-tile="${gapTile}"]`).last().hover();
check('hovering a tile tag in the history outlines its tile', (await pointed()) === gapTile);
await snap('hover-history-tag');
await page.mouse.move(5, 5);

// No session: no picker.
await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close());
await page.waitForTimeout(1000);
await input.click();
await page.keyboard.type('last race with @fer');
check('no session, no picker', !(await pickerOpen()));
await snap('no-session');

await finish();
