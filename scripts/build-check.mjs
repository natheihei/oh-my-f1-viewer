// Runs build mode in the real app, over a real replay race, muted, with the real agent: the cases in
// docs/BUILD_MODE.md, "Checking it", numbered the same. Needs F1 TV signed in and the agent set up, and a mods folder with no
// mods in it: it works in the real profile's, and leaves it as it found it. Prints what the agent says,
// which could give the race away: use a session you've watched.
// Usage: node scripts/build-check.mjs <screenshot-dir> [sessionKey] [year] [lap]
//   F1A_BUILD_PARTS picks parts to run, like "a" or "bc": a saves a build, b undoes one, c quits in one.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, typeInPalette } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/build-check.mjs <screenshot-dir> [sessionKey] [year] [lap]');
const [sessionKey, year, LAP] = [Number(process.argv[3] ?? 11396), Number(process.argv[4] ?? 2026), Number(process.argv[5] ?? 25)];
const PARTS = process.env.F1A_BUILD_PARTS ?? 'abc';
mkdirSync(outDir, { recursive: true });

const profile = path.join(os.homedir(), '.config', 'f1a');
const modsDir = path.join(profile, 'mods');
const snapshotDir = path.join(profile, 'mods-snapshot');
const sessionsDir = (kind) => path.join(profile, 'pi-agent', kind === 'build' ? 'build-sessions' : 'sessions');
const LAP_FORM = readFileSync(path.resolve('examples/mods/lap_form/main.tsx'), 'utf8');

const modFolders = () =>
  existsSync(modsDir) ? readdirSync(modsDir).filter((n) => !n.startsWith('.') && statSync(path.join(modsDir, n)).isDirectory()).sort() : [];
const source = (name) => {
  const dir = path.join(modsDir, name);
  const entry = ['main.tsx', 'main.ts', 'main.jsx', 'main.js'].find((f) => existsSync(path.join(dir, f)));
  return entry ? readFileSync(path.join(dir, entry), 'utf8') : null;
};
const newest = (dir) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() : [];
  return files.length ? readFileSync(path.join(dir, files.at(-1)), 'utf8') : '';
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`);
};
const section = (title) => console.log(`\n== ${title}`);

if (modFolders().length && !process.env.F1A_BUILD_KEEP) throw new Error(`The mods folder already has mods (${modFolders().join(', ')}): this check needs it empty.`);
rmSync(snapshotDir, { recursive: true, force: true });

let app = null;
let page = null;
let stop = async () => {};
let spoilerAnswer = null;
let spoilerSeen = 0;
/** Turns in which the agent read the whole session. */
let readAheads = 0;
let watcher = null;

async function launch(port) {
  ({ app, page, stop } = await startApp(port));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console error]', m.text().slice(0, 200));
  });
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    window.events = [];
    window.f1a.ai.onEvent((e) => window.events.push(e));
    Object.assign(window, { host, read });
  });
  // Counts every spoiler check, and answers it when told how.
  let busy = false;
  watcher = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (await page.$('[data-testid="spoiler-check"]')) {
        spoilerSeen += 1;
        if (spoilerAnswer) await (await page.$(`[data-testid="spoiler-${spoilerAnswer}"]`))?.click();
      }
    } catch {
      // The page is closing, or the check went between finding and clicking it.
    } finally {
      busy = false;
    }
  }, 250);
}

async function close() {
  clearInterval(watcher);
  await stop();
}

async function cleanUp() {
  for (const name of modFolders()) rmSync(path.join(modsDir, name), { recursive: true, force: true });
  rmSync(snapshotDir, { recursive: true, force: true });
}

async function fail(message) {
  console.log('FAIL', message);
  await close().catch(() => {});
  await cleanUp();
  process.exit(1);
}
process.on('uncaughtException', (e) => void fail(e.stack ?? e.message));
process.on('unhandledRejection', (e) => void fail(e?.stack ?? String(e)));

const live = (fn, arg) => page.evaluate(fn, arg);
const build = () => live(() => window.read().build);
const whole = (sql, params = []) => live(({ sql, params }) => window.host.data.sql({ sql, params, asOf: 'session' }).then((r) => r.rows), { sql, params });
const where = () =>
  live(() => {
    const { clock, sessionData } = window.read();
    return { t: clock.timeSec, playing: clock.playing, playhead: sessionData.state === 'ready' ? sessionData.playheadMs : null };
  });
const tilesNow = () => live(() => window.read().layout.tiles.map((t) => ({ id: t.id, type: t.component.type, key: t.component.key, x: t.x, y: t.y, w: t.w, h: t.h })));
const modState = (name) => live((name) => window.read().mods.find((m) => m.name === name) ?? null, name);
/** A screenshot. Playwright's capture sometimes never returns here while playback is paused, so it falls back to Electron's own. */
const shot = async (file) => {
  const target = path.join(outDir, file);
  try {
    await page.screenshot({ path: target, timeout: 8000 });
  } catch {
    const frame = await page.evaluate(() => new Promise((r) => { const s = performance.now(); requestAnimationFrame(() => r(Math.round(performance.now() - s))); setTimeout(() => r(null), 3000); }));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(target, Buffer.from(png, 'base64'));
    console.log(`  [${file}: fell back to the window's own capture; the page drew a frame in ${frame ?? 'over 3000'}ms]`);
  }
};
// The chrome is set in capitals by CSS, which innerText follows: compare in lower case, on one line.
const plain = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const tagText = () => page.locator('[data-testid=build-tag]').innerText().then(plain, () => '');
// A click by event, for what's on a tile: the open palette can lie over the tile and take a click by position.
const press = (locator) => locator.dispatchEvent('click');
const history = () => page.locator('[data-testid=palette-history]').innerText().catch(() => '');
const tile = (type) => page.locator(`[data-tile-type="${type}"]`);
const draft = (type) => page.locator(`[data-testid=suggestion]:has([data-draft-type="${type}"])`);

async function until(label, test, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await test();
    if (last) return last;
    await page.waitForTimeout(250);
  }
  check(label, false, 'timed out');
  return null;
}

/** Sends a message and waits for the agent to finish. Reports what it did. */
async function say(text, timeoutMs = 420_000) {
  console.log(`\n> ${text}`);
  await live(() => {
    window.events.length = 0;
  });
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: timeoutMs });
  const events = await live(() => window.events);
  const end = events.find((e) => e.type === 'turn_end' || e.type === 'error');
  const names = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
  if (events.some((e) => e.type === 'tool_start' && e.name === 'query_session' && e.args?.asOf === 'session')) readAheads += 1;
  const notes = events.filter((e) => e.type === 'tool_end' && e.note).map((e) => e.note);
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  if (end.type === 'error') console.log(`  ERROR: ${end.message}`);
  console.log(`  tools: ${names.join(' ')}`);
  console.log(`  reply: ${reply}`);
  await page.waitForTimeout(2500);
  return { reply, names, notes, ok: end.type !== 'error' };
}

async function openRace() {
  const signedIn = await live(async () => await window.host.account.status());
  if (!signedIn.f1tv.signedIn) await fail('F1 TV is not signed in: sign in in the app, then run this again.');
  if (!signedIn.agent.ready) await fail('The agent is not set up: run /settings-agent in the app, then run this again.');
  const opened = await live(
    async ({ sessionKey, year }) => {
      const { host, read } = window;
      host.audio.setVolume({ volume: 0 });
      const events = (await host.catalog.events({ year })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
      let race = null;
      for (const e of events) {
        race = (await host.catalog.sessions({ pageId: e.pageId, year })).find((s) => s.type === 'race' && String(s.sessionKey) === String(sessionKey));
        if (race) break;
      }
      if (!race) return { error: `No replay race with session key ${sessionKey} in ${year}` };
      await host.session.open({ contentId: race.contentId, title: race.title });
      const deadline = Date.now() + 120_000;
      const ready = () => read().sessionData.state === 'ready' && read().sessionData.playheadMs != null && read().clock.end > 0;
      while (Date.now() < deadline && !ready()) await new Promise((r) => setTimeout(r, 500));
      return ready() ? { title: race.title } : { error: `Session data is ${read().sessionData.state}` };
    },
    { sessionKey, year },
  );
  if (opened.error) await fail(opened.error);
  console.log(`opened ${opened.title}`);
  await page.waitForTimeout(3000);
}

/** When each lap began: the first car to start it. */
const lapStarts = () => whole('SELECT lap_number AS lap, MIN(date_start) AS start FROM laps WHERE date_start IS NOT NULL GROUP BY lap_number ORDER BY lap_number');
const lapAt = (laps, ms) => laps.filter((l) => l.start <= ms).at(-1)?.lap ?? 0;

/** The buttons of a lap stepper, wherever it's drawn: back first, forward last. */
async function stepperButtons(scope) {
  const buttons = scope.locator('button:not([data-testid=look-ahead-allow])');
  const texts = await buttons.allInnerTexts();
  const find = (re, fallback) => {
    const i = texts.findIndex((t) => re.test(t));
    return buttons.nth(i >= 0 ? i : fallback);
  };
  return { count: texts.length, texts, back: find(/prev|back|‹|«|←|<|◀|−|-/i, 0), forward: find(/next|forw|›|»|→|>|▶|\+/i, texts.length - 1) };
}

// ---------------------------------------------------------------------------------------------------
// Part a: a build that's saved.
async function partSave() {
  await launch(5187);
  await openRace();
  // A mod from before the build, on screen: the build will edit it.
  mkdirSync(path.join(modsDir, 'lap_form'), { recursive: true });
  writeFileSync(path.join(modsDir, 'lap_form', 'main.tsx'), LAP_FORM);
  await until('lap_form loads', async () => (await modState('lap_form'))?.state === 'ready');
  await live(() => window.host.layout.add({ items: [{ type: 'lap_form', props: {} }] }));
  await live(() => {
    window.host.playback.seekToStart();
    window.host.playback.play();
  });
  await page.waitForTimeout(4000);
  const laps = await lapStarts();

  section('Entering');
  await page.locator('[data-testid=palette-input]').fill('/b');
  const row = page.locator('[data-testid=palette-suggestions]');
  check('1 /b lists /build', (await row.innerText()).includes('/build'));
  const warning = page.locator('[data-testid=command-warning]');
  check('1 with the spoiler warning beside it', (await warning.innerText().catch(() => '')) === '! spoiler the agent looks ahead without asking');
  const color = await warning.evaluate((el) => getComputedStyle(el).color).catch(() => '');
  check('1 in the hint grey', color === 'rgb(138, 138, 138)', color);
  const listed = await row.locator('.palette-suggestion').first().evaluate((el) => ({ text: el.innerText.replace(/\s+/g, ' '), height: el.getBoundingClientRect().height }));
  check('1 it reads "Enter build mode", on one line, with no argument hint', listed.text.includes('Enter build mode') && !listed.text.includes('<') && listed.height < 24, JSON.stringify(listed));
  await shot('build-01-command.png');
  await page.locator('[data-testid=palette-input]').fill('');

  const before = { tiles: await tilesNow(), at: await where() };
  spoilerSeen = 0;
  let r = await say('/build a controller that can go back and forward laps');
  check('2 the turn finished', r.ok);
  const afterEntry = { tiles: await tilesNow(), at: await where() };
  check('2 the build tag shows', (await tagText()).startsWith('build'));
  check('2 no spoiler check', spoilerSeen === 0, `${spoilerSeen} seen`);
  const yellow = 'rgb(255, 209, 46)';
  const frame = await page.locator('[data-testid=palette]').evaluate((el) => getComputedStyle(el).borderTopColor);
  const prompt = await page.locator('.palette-prompt').evaluate((el) => getComputedStyle(el).color);
  check('2 the palette frame and prompt are yellow', frame === yellow && prompt === yellow, `${frame} ${prompt}`);
  check('2 the layout is untouched', JSON.stringify(before.tiles) === JSON.stringify(afterEntry.tiles));
  check('2 playback paused on entering', before.at.playing && !afterEntry.at.playing, `${before.at.t.toFixed(1)}s to ${afterEntry.at.t.toFixed(1)}s`);

  section('A new mod');
  const changes = (await build()).changes;
  const stepper = changes.find((c) => c.change === 'added')?.name;
  if (!stepper) await fail(`The agent added no mod: ${JSON.stringify(changes)}`);
  console.log(`  the agent named it ${stepper}`);
  const text = await history();
  check('3 the palette shows the write and "loaded"', new RegExp(`wrote ${stepper}/main\\.tsx · loaded`).test(text), r.notes.join(' | '));
  check('3 with no version number', !/\bv\d+\b/.test(r.notes.join(' ')));
  check('3 the tag reads "build · 1 change"', (await tagText()).includes('build · 1 change'), await tagText());
  check('4 it is in the strip, marked draft', plain(await draft(stepper).locator('[data-testid=draft-badge]').innerText().catch(() => '')) === 'draft');
  check('4 without the agent calling suggest_tiles', !r.names.includes('suggest_tiles'), r.names.join(' '));
  await shot('build-02-draft.png');

  // Mid-race, paused, so only the stepper moves the playhead.
  const mid = laps.find((l) => l.lap === LAP).start + 20_000;
  await live((dateMs) => {
    window.host.playback.pause();
    window.host.playback.seekToDate({ dateMs });
  }, mid);
  await page.waitForTimeout(4000);
  const preview = draft(stepper);
  check('5 the agent declared it with looksAhead', /looksAhead:\s*true/.test(source(stepper) ?? ''));
  const asks = await until('5 the preview asks before looking ahead', async () => (await preview.locator('[data-testid=look-ahead-warning]').count()) === 1, 8000);
  if (asks) {
    check('5 the preview asks before looking ahead', true);
    await shot('build-03-warning.png');
    await preview.locator('[data-testid=look-ahead-allow]').click();
    await page.waitForTimeout(2500);
  }
  check('5 Allow clears the warning', (await preview.locator('[data-testid=look-ahead-warning]').count()) === 0);
  let buttons = await stepperButtons(preview);
  console.log(`  its buttons: ${JSON.stringify(buttons.texts)}`);
  let at = await where();
  check(`5 the playhead starts in lap ${LAP}`, lapAt(laps, at.playhead) === LAP, `lap ${lapAt(laps, at.playhead)}`);
  await buttons.forward.click();
  await page.waitForTimeout(4000);
  let now = await where();
  const next = laps.find((l) => l.lap === LAP + 1).start;
  check(`5 forward, in the preview, lands at the start of lap ${LAP + 1}`, Math.abs(now.playhead - next) < 5000, `${((now.playhead - next) / 1000).toFixed(1)}s from it`);
  await buttons.back.click();
  await page.waitForTimeout(4000);
  const back = await where();
  check('5 back moves playback back', back.playhead < now.playhead - 5000, `lap ${lapAt(laps, back.playhead)}`);
  await shot('build-04-preview-works.png');

  await preview.focus();
  await page.keyboard.press('Enter');
  await tile(stepper).waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1500);
  const tileId = await tile(stepper).getAttribute('data-tile');
  const titleOf = (id) => page.locator(`.grid-stack-item[gs-id="${id}"] .tile-title`);
  check('6 Enter adds it to the grid, already approved', (await tile(stepper).locator('[data-testid=look-ahead-warning]').count()) === 0);
  const aheadSlot = page.locator(`.grid-stack-item[gs-id="${tileId}"] .tile-slot-ahead`);
  const ahead = (await aheadSlot.isVisible()) ? plain(await aheadSlot.innerText()) : '(hidden)';
  check('6 its header says "ahead"', ahead === 'ahead', ahead);
  const formId = (await tilesNow()).find((t) => t.type === 'lap_form').id;
  const [mine, other] = await Promise.all([tileId, formId].map((id) => titleOf(id).evaluate((el) => getComputedStyle(el).color)));
  check('6 in the same grey as any title', mine === other, `${mine} vs ${other}`);
  check('6 the tile is marked a draft', (await tile(stepper).getAttribute('data-tile-mark')) === 'draft');
  await shot('build-05-added.png');

  await live((id) => window.host.layout.remove({ tiles: [id] }), tileId);
  await page.waitForTimeout(500);
  await live((type) => window.host.layout.add({ items: [{ type, props: {} }] }), stepper);
  await tile(stepper).waitFor({ state: 'visible', timeout: 10_000 });
  check('7 a new tile of the same mod asks again', !!(await until('7 asks again', async () => (await tile(stepper).locator('[data-testid=look-ahead-warning]').count()) === 1, 8000)));
  await press(tile(stepper).locator('[data-testid=look-ahead-allow]'));
  await page.waitForTimeout(2500);
  buttons = await stepperButtons(tile(stepper));
  at = await where();
  await press(buttons.forward);
  await page.waitForTimeout(4000);
  now = await where();
  check('7 once allowed, the tile steps a lap too', lapAt(laps, now.playhead) === lapAt(laps, at.playhead) + 1, `lap ${lapAt(laps, at.playhead)} to ${lapAt(laps, now.playhead)}`);

  section('An edit');
  const placed = (await tilesNow()).find((t) => t.type === stepper);
  const versionBefore = (await modState(stepper)).version;
  r = await say('show the lap number bigger');
  const after = (await tilesNow()).find((t) => t.type === stepper);
  check('8 the same tile, in the same place', JSON.stringify(after) === JSON.stringify(placed), JSON.stringify(after));
  check('8 running new code', (await modState(stepper)).version > versionBefore && (await modState(stepper)).state === 'ready');
  check('8 still approved', (await tile(stepper).locator('[data-testid=look-ahead-warning]').count()) === 0);
  check('8 the tag still reads 1 change', (await tagText()).includes('build · 1 change'), await tagText());

  r = await say('make lap form show the last 12 laps instead of 8');
  check('9 lap_form was edited on disk', source('lap_form') !== LAP_FORM && /12/.test(source('lap_form') ?? ''));
  check('9 its tile is marked edited', (await tile('lap_form').getAttribute('data-tile-mark')) === 'edited');
  const outline = await tile('lap_form').evaluate((el) => getComputedStyle(el, '::after').borderTopStyle);
  check('9 with a dashed outline', outline === 'dashed', outline);
  check('9 the tag reads "build · 2 changes"', (await tagText()).includes('build · 2 changes'), await tagText());
  check('9 it is not in the strip, being on screen', (await draft('lap_form').count()) === 0);
  await shot('build-06-edited.png');

  // A save that doesn't compile: the tile keeps running what last loaded, and the agent has to get past it.
  const good = source(stepper);
  writeFileSync(path.join(modsDir, stepper, 'main.tsx'), good.replace('export default defineComponent(', 'export default defineComponent(('));
  await until('10 the broken save fails', async () => (await modState(stepper))?.state === 'failed');
  await page.waitForTimeout(1000);
  check('10 a broken save keeps the last good version on screen', (await stepperButtons(tile(stepper))).count >= 2 && !(await tile(stepper).innerText()).includes('This tile stopped'));
  check('10 mod.error says why', existsSync(path.join(modsDir, stepper, 'mod.error')));
  r = await say('make the lap number yellow');
  check('10 the agent got it loading again, unasked', (await modState(stepper))?.state === 'ready' && !existsSync(path.join(modsDir, stepper, 'mod.error')), r.notes.join(' | '));

  section('The picture');
  r = await say('give the buttons a 3px white border, and check how it looks');
  const buildLog = newest(sessionsDir('build'));
  check('23 the build agent took a picture of the draft', r.names.includes('look_at') && buildLog.includes('"look_at"') && buildLog.includes('"image"'), r.names.join(' '));
  const borders = await tile(stepper)
    .locator('button')
    .evaluateAll((els) =>
      els.map((el) => {
        const s = getComputedStyle(el);
        return [s.borderTopWidth, s.borderTopColor];
      }),
    );
  const whitish = (c) => (c.match(/\d+/g) ?? []).slice(0, 3).every((n) => Number(n) > 200);
  check('23 and the buttons on screen have the border', borders.length > 0 && borders.every(([width, color]) => parseFloat(width) >= 3 && whitish(color)), JSON.stringify(borders[0]));
  await shot('build-07-border.png');

  section('Props');
  // Worded as a new mod: asked for a plain battle chart, the agent rightly suggests the app's own gap chart.
  r = await say('build a new mod called duel, for Hamilton and Norris: for each of the last ten laps, which of the two was faster and by how much');
  const battle = (await build()).changes.find((c) => c.change === 'added' && c.name !== stepper)?.name;
  if (!battle) check('11 the agent added a battle mod', false, JSON.stringify((await build()).changes));
  else {
    console.log(`  the agent named it ${battle}`);
    const items = await live(() => window.read().suggestions.items);
    const offered = items.find((i) => i.type === battle);
    const roster = await live(() => window.read().sessionData.drivers.filter((d) => ['HAM', 'NOR'].includes(d.name_acronym)).map((d) => d.driver_number));
    const numbers = JSON.stringify(offered?.props ?? {}).match(/\d+/g)?.map(Number) ?? [];
    check('11 it previews with the two drivers named', roster.length === 2 && roster.every((n) => numbers.includes(n)), JSON.stringify(offered?.props));
    check('11 and only that preview, not a second with no props', items.filter((i) => i.type === battle).length === 1);
    await page.waitForTimeout(2000);
    await shot('build-08-battle.png');
    await live(({ type, props }) => window.host.suggestions.dismiss() ?? window.host.layout.add({ items: [{ type, props }] }), { type: battle, props: offered?.props ?? {} });
    await tile(battle).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(3000);
    const drawn = await tile(battle).first().evaluate((el) => ({ text: el.innerText, canvases: el.querySelectorAll('canvas, svg').length }));
    check('12 on the grid with those props, it draws something', !drawn.text.includes('This tile stopped') && (drawn.canvases > 0 || drawn.text.trim().length > 0), JSON.stringify(drawn).slice(0, 200));
    await shot('build-09-battle-on-grid.png');
  }
  section('Not drawing');
  const placesOf = async (type, where = 'tile') => (await live(() => window.host.health.settled())).filter((p) => p.type === type && p.where === where);
  const heard = (text) => newest(sessionsDir('build')).includes(text);

  // A mod about one driver, with nobody named: the save says its draft can't draw yet.
  r = await say("build a new mod called solo: one driver's last five lap times, as a list. It takes the driver as a required prop named driver. I haven't decided whose yet, so don't pick one");
  check('24 the agent heard that its draft needs a driver', heard('Draft solo in the strip: needs driver'), r.names.join(' '));
  const soloCard = await draft('solo').innerText().catch(() => '');
  check('24 the strip has a card for it that says so', plain(soloCard).includes('needs driver'), soloCard);
  check('24 and the agent asked whose, without picking', /\?/.test(r.reply) && !r.names.includes('suggest_tiles'), r.reply);
  await shot('build-09a-needs-driver.png');

  // An edit that changes a mod's props under its tile: the agent hears before the turn ends, and fixes the tile.
  if (battle) {
    r = await say(`change ${battle} to be about one driver only, against the fastest lap so far: replace driver_a and driver_b with one required prop named driver. The tile on screen should be about Hamilton`);
    check("25 the agent heard that the tile's props no longer fit", heard(`(${battle}): needs driver`), r.names.join(' '));
    const [fixed] = await placesOf(battle);
    check('25 and gave the tile its driver in the same turn', r.names.includes('edit_tile') && fixed?.state === 'drawn', `${r.names.join(' ')} ${JSON.stringify(fixed)}`);
    await shot('build-09b-props-fixed.png');
  }

  // A render error that came up between turns: the next message's app state names it.
  mkdirSync(path.join(modsDir, 'stopped'), { recursive: true });
  writeFileSync(
    path.join(modsDir, 'stopped', 'main.tsx'),
    `import Type from 'typebox';
import { defineComponent } from 'f1a';

const lap = undefined as unknown as { number: number };

export default defineComponent({
  name: 'stopped',
  title: 'Stopped',
  description: 'Shows a lap number.',
  args: Type.Object({}),
  size: { aspect: 2, min: { width: 200, height: 100 } },
  spec: () => ({ key: 'stopped', label: 'Stopped' }),
  View: () => <div style={{ padding: 12 }}>lap {lap.number}</div>,
});
`,
  );
  await until('26 the mod loads', async () => (await modState('stopped'))?.state === 'ready');
  await live(() => window.host.suggestions.dismiss() ?? window.host.layout.add({ items: [{ type: 'stopped', props: {} }] }));
  await until('26 its tile stops', async () => (await placesOf('stopped'))[0]?.state === 'error');
  await shot('build-09c-stopped.png');
  r = await say('is everything on screen drawing? fix what is not');
  check('26 the app state named the tile that stopped', heard('not drawing: Tile \\"Stopped\\" (stopped): render error'), r.names.join(' '));
  check('26 and the agent fixed its code', (r.names.includes('edit') || r.names.includes('write')) && (await placesOf('stopped'))[0]?.state === 'drawn', `${r.names.join(' ')} ${JSON.stringify((await placesOf('stopped'))[0])}`);
  await shot('build-09d-stopped-fixed.png');

  // The agent reads ahead when it needs to. If it never did, ask for something that needs it.
  if (readAheads === 0) r = await say(`check ${stepper}'s lap query against the whole session's data, and fix it if it's wrong. Don't tell me what the data shows`);
  check('19 the build read the whole session without a check', spoilerSeen === 0 && readAheads > 0, `${readAheads} turns read ahead, ${spoilerSeen} checks`);

  section('Leaving by Save');
  const built = (await build()).changes;
  const tilesBefore = await tilesNow();
  const entered = (await build()).enteredAtSec;
  await page.locator('[data-testid=build-save]').click();
  await until('14 the tag goes', async () => (await page.locator('[data-testid=build-tag]').count()) === 0);
  await page.waitForTimeout(1500);
  check('14 the tag is gone', (await page.locator('[data-testid=build-tag]').count()) === 0);
  check('14 the mods stay on disk', built.filter((c) => c.change !== 'deleted').every((c) => source(c.name) != null), modFolders().join(' '));
  check('14 the snapshot folder is gone', !existsSync(snapshotDir));
  check('14 the tiles stay', JSON.stringify(await tilesNow()) === JSON.stringify(tilesBefore));
  check('14 with no draft marks left', (await page.locator('[data-tile-mark]').count()) === 0);
  const summary = (await history()).split('\n').findLast((l) => l.includes('Saved.')) ?? '';
  console.log(`  ${summary}`);
  check('14 the palette says what was built', built.every((c) => summary.includes(c.name)), summary);
  const offer = page.locator('[data-testid=palette-action]');
  check('16 it offers the way back', /^back to \d+:\d\d:\d\d$/.test(await offer.innerText().catch(() => '')), await offer.innerText().catch(() => 'no offer'));
  const stay = await where();
  await page.waitForTimeout(2000);
  check('16 and leaves the playhead alone until asked', Math.abs((await where()).t - stay.t) < 3);
  await shot('build-10-saved.png');
  await offer.click();
  await page.waitForTimeout(4000);
  check('16 clicking it returns there', Math.abs((await where()).t - entered) < 5, `entered at ${entered.toFixed(1)}s, now ${(await where()).t.toFixed(1)}s`);
  check('16 the offer is taken once', (await offer.count()) === 0);

  section('Spoilers');
  r = await say('pause');
  const viewLog = newest(sessionsDir('view'));
  const line = viewLog.match(/build mode: the user left it having saved this\. [^\\"]*/)?.[0] ?? '';
  console.log(`  ${line}`);
  check("20 the viewing agent's next request holds the app's one line", built.every((c) => line.includes(c.name)), line);
  check('20 and nothing else of the build', !/"toolName":"(write|edit)"|look_at|go back and forward laps|lap number bigger/.test(viewLog));
  check('20 the build is stored apart', newest(sessionsDir('build')).includes('"toolName":"write"'));
  spoilerSeen = 0;
  spoilerAnswer = 'no';
  const held = await where();
  r = await say('go to lap 40');
  spoilerAnswer = null;
  check('21 back in view mode, a forward seek asks again', spoilerSeen > 0, `${spoilerSeen} checks`);
  check('21 and No leaves the video where it was', Math.abs((await where()).t - held.t) < 3);
  for (const { name } of built.filter((c) => c.change !== 'deleted')) {
    const text = source(name) ?? '';
    writeFileSync(path.join(outDir, `build-source-${name}.tsx`), text);
    // Session times are 13-digit UTC milliseconds, and a table of results would be a long run of numbers.
    const stamps = text.match(/\b1[6-9]\d{11}\b/g) ?? [];
    const tables = text.match(/(?:\d+(?:\.\d+)?\s*,\s*){8,}/g) ?? [];
    check(`22 ${name} has no race data written into it`, stamps.length === 0 && tables.length === 0, [...stamps, ...tables].join(' '));
  }
  await live(() => window.host.session.close());
  await close();
  return { stepper };
}

// ---------------------------------------------------------------------------------------------------
// Part b: a build that's undone. Starts from what part a saved.
async function partUndo(stepper) {
  await launch(5188);
  await openRace();
  const laps = await lapStarts();
  await live((dateMs) => {
    window.host.playback.seekToDate({ dateMs });
    window.host.playback.play();
  }, laps.find((l) => l.lap === LAP).start);
  await until('the saved mods load', async () => (await modState(stepper))?.state === 'ready' && (await modState('lap_form'))?.state === 'ready');
  await live((type) => window.host.layout.add({ items: [{ type: 'lap_form', props: {} }, { type, props: {} }] }), stepper);
  await tile(stepper).waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(3000);
  const savedForm = source('lap_form');
  const savedStepper = source(stepper);
  const folders = modFolders();

  section('A delete');
  spoilerSeen = 0;
  let r = await say(`/build remove the ${stepper} mod`);
  check('13 the mod is gone from disk', source(stepper) == null, modFolders().join(' '));
  check('13 its tile is off screen', (await tile(stepper).count()) === 0);
  check('13 the tag counts the change', (await tagText()).includes('build · 1 change'), await tagText());
  check('13 the palette says it was removed', r.notes.includes(`removed ${stepper}`), r.notes.join(' | '));
  await shot('build-11-deleted.png');

  r = await say('make lap form show the last 5 laps');
  r = await say('a tile that shows the lap the race is on, as one big number');
  const changes = (await build()).changes;
  const added = changes.find((c) => c.change === 'added')?.name;
  console.log(`  changes: ${JSON.stringify(changes)}`);
  check('15 three changes before undoing', changes.length === 3 && (await tagText()).includes('build · 3 changes'), await tagText());
  if (added) {
    await draft(added).focus();
    await page.keyboard.press('Enter');
    await tile(added).waitFor({ state: 'visible', timeout: 10_000 });
  }
  await page.waitForTimeout(1500);
  await shot('build-12-before-undo.png');

  section('Leaving by Undo all');
  const formVersion = (await modState('lap_form')).version;
  const stay = await where();
  await page.locator('[data-testid=build-undo]').click();
  await until('15 the tag goes', async () => (await page.locator('[data-testid=build-tag]').count()) === 0);
  await until('15 the mods settle', async () => (await modState('lap_form'))?.version > formVersion && (await modState(stepper))?.state === 'ready' && (added ? (await modState(added)) == null : true));
  await page.waitForTimeout(1500);
  check("15 the new mod's folder is gone", added != null && source(added) == null, modFolders().join(' '));
  check('15 and its tile', added != null && (await tile(added).count()) === 0);
  check('15 the edited mod has its old code', source('lap_form') === savedForm);
  check('15 on screen too', (await modState('lap_form')).state === 'ready' && (await tile('lap_form').count()) === 1 && (await tile('lap_form').getAttribute('data-tile-mark')) == null);
  check('15 the deleted mod is back', source(stepper) === savedStepper && (await modState(stepper))?.state === 'ready');
  check('15 the folder is as it was on entry', JSON.stringify(modFolders()) === JSON.stringify(folders), modFolders().join(' '));
  check('15 the snapshot folder is gone', !existsSync(snapshotDir));
  check('15 the palette says how much was undone', (await history()).includes('Undid 3 changes.'));
  check('15 no spoiler check in the whole build', spoilerSeen === 0);
  await page.waitForTimeout(2000);
  const moved = await where();
  check('16 leaving without taking the offer leaves the playhead alone', Math.abs(moved.t - stay.t) < 2, `${stay.t.toFixed(1)}s to ${moved.t.toFixed(1)}s`);
  await shot('build-13-undone.png');
  await live(() => window.host.session.close());
  await close();
}

// ---------------------------------------------------------------------------------------------------
// Part c: quitting in the middle of a build. No session or agent needed.
async function partQuit() {
  if (!existsSync(path.join(modsDir, 'lap_form'))) {
    mkdirSync(path.join(modsDir, 'lap_form'), { recursive: true });
    writeFileSync(path.join(modsDir, 'lap_form', 'main.tsx'), LAP_FORM);
  }
  const folders = modFolders();
  const form = source('lap_form');

  section('Quitting mid-build');
  await launch(5189);
  await typeInPalette(page, '/build');
  await until('the build tag shows', async () => (await tagText()).includes('build ×'));
  check('2 /build alone enters with a plain "build ×"', (await tagText()).trim() === 'build ×', await tagText());
  check('17 a snapshot is open', existsSync(path.join(snapshotDir, 'complete')));
  // Written by hand, not the agent: the tag follows the folder, whoever changes it.
  cpSync(path.join(modsDir, 'lap_form'), path.join(modsDir, 'quit_test'), { recursive: true });
  writeFileSync(path.join(modsDir, 'quit_test', 'main.tsx'), LAP_FORM.replaceAll('lap_form', 'quit_test'));
  writeFileSync(path.join(modsDir, 'lap_form', 'main.tsx'), LAP_FORM.replace('const LAPS = 8;', 'const LAPS = 3;'));
  await until('the tag counts both', async () => (await tagText()).includes('build · 2 changes'));
  check('4 the tag follows the folder with no agent involved', (await tagText()).includes('build · 2 changes'), await tagText());
  await shot('build-14-before-quit.png');
  app.process().kill('SIGKILL');
  await page.waitForTimeout(500).catch(() => {});
  await close();
  await new Promise((r) => setTimeout(r, 2000));

  await launch(5189);
  await page.waitForTimeout(3000);
  check('17 after a restart, the new mod is gone', source('quit_test') == null, modFolders().join(' '));
  check('17 the edited mod is as it was on entry', source('lap_form') === form);
  check('17 the folder matches', JSON.stringify(modFolders()) === JSON.stringify(folders));
  check('17 the snapshot is gone', !existsSync(snapshotDir));
  check('17 the app is not in build mode', (await page.locator('[data-testid=build-tag]').count()) === 0 && !(await build()).active);
  check('17 and asks nothing', !/build|undo|unsaved/i.test(await history()), await history());
  await shot('build-15-after-restart.png');
  await close();
  await new Promise((r) => setTimeout(r, 2000));

  // As if the app died while copying the snapshot: files, and no marker.
  mkdirSync(path.join(snapshotDir, 'files', 'lap_form'), { recursive: true });
  writeFileSync(path.join(snapshotDir, 'files', 'lap_form', 'main.tsx'), '// half a copy');
  writeFileSync(path.join(modsDir, 'lap_form', 'main.tsx'), LAP_FORM.replace('const LAPS = 8;', 'const LAPS = 6;'));
  await launch(5189);
  await page.waitForTimeout(3000);
  check('18 a half copy is ignored: the mods folder is left alone', source('lap_form')?.includes('const LAPS = 6;') === true);
  check('18 and cleared away', !existsSync(snapshotDir));
  check('18 the mod loads', (await until('18 loads', async () => (await modState('lap_form'))?.state === 'ready')) === true);
  await close();
}

let stepper = process.env.F1A_BUILD_STEPPER ?? null;
if (PARTS.includes('a')) ({ stepper } = await partSave());
if (PARTS.includes('b')) {
  if (!stepper || source(stepper) == null) await fail('Part b needs the mods part a saved: run them together, or set F1A_BUILD_STEPPER and F1A_BUILD_KEEP.');
  await partUndo(stepper);
}
if (PARTS.includes('c')) await partQuit();

if (!process.env.F1A_BUILD_KEEP || PARTS.includes('c')) await cleanUp();
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
