// Checks a tile's "Attach error to agent" in an f1a of its own (see isolated.mjs), over a real replay race,
// muted, and saves a screenshot at each step. It writes a small mod, attach_check, that names the car
// ahead and so throws for the leader, who has none: the kind of render error the button is for.
//
// By default there's no agent sign-in: it attaches the error, types into the tray, and catches what would
// go to the agent in place of sending it. Then it offers build mode as offer_build would, and turns it down.
// With --agent the real models answer: the error goes to the viewing agent with no words, and once it
// offers build mode the check switches, waits for the build agent's turn, and checks the tile draws. That
// runs on ~/.config/f1a itself, so the agent's login is never copied, and refuses while another f1a is using
// it. It puts the mods folder back afterwards: Undo all, then the test mod goes.
// Needs the F1 TV sign-in. Prints race data: use a race you've watched.
// Usage: node scripts/attach-check.mjs <out-dir> [--agent] [--session <key>] [--year 2026] [--lap 30]
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { typeInPalette } from './harness.mjs';
import { frontRunners, openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const outDir = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
if (!outDir) throw new Error('Usage: node scripts/attach-check.mjs <out-dir> [--agent] [--session <key>] [--year 2026] [--lap 30]');
const agent = argv.includes('--agent');
mkdirSync(outDir, { recursive: true });

const MOD = 'attach_check';
const MOD_SOURCE = `import Type from 'typebox';
import { defineComponent, useSql } from 'f1a';

const LATEST = \`WITH p AS (SELECT driver_number, position, ROW_NUMBER() OVER (PARTITION BY driver_number ORDER BY date DESC) rn FROM position),
  i AS (SELECT driver_number, interval, ROW_NUMBER() OVER (PARTITION BY driver_number ORDER BY date DESC) rn FROM intervals)
  SELECT p.driver_number, p.position, i.interval FROM p LEFT JOIN i ON i.driver_number = p.driver_number AND i.rn = 1 WHERE p.rn = 1\`;

function View({ props }: { props: { drivers: number[] } }) {
  const view = useSql(LATEST);
  if (view.state !== 'ready') return null;
  const me = view.rows.find((r) => Number(r.driver_number) === props.drivers[0]);
  const ahead = view.rows.find((r) => Number(r.position) === Number(me?.position) - 1);
  return (
    <div style={{ padding: '8px 12px', color: '#e7e7e7', fontSize: 20 }}>
      {typeof me?.interval === 'number' ? \`+\${me.interval.toFixed(3)}\` : '—'} to #{(ahead as { driver_number: number }).driver_number}
    </div>
  );
}

export default defineComponent({
  name: '${MOD}',
  title: 'Attach check',
  description: 'The gap to the car ahead, and who it is.',
  args: Type.Object({ drivers: Type.Array(Type.Number(), { minItems: 1, maxItems: 1 }) }),
  needs: ['timing'],
  size: { aspect: 2.5, min: { width: 300, height: 90 } },
  spec: (props) => ({ key: \`${MOD}:\${props.drivers[0]}\`, label: 'Attach check', drivers: props.drivers }),
  View,
});
`;

const { page, log, stop, userData } = await startIsolatedApp(outDir, { name: 'attach', mainProfile: agent });
const modDir = path.join(userData, 'mods', MOD);
const cleanUp = async () => {
  // Undo all puts back whatever a build changed; the test mod was there before it began, so it goes after.
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    if (read().build.active) await host.build.undo();
  }).catch(() => {});
  rmSync(modDir, { recursive: true, force: true });
  await stop();
};
const fail = async (message) => {
  log('FAIL', message);
  await cleanUp();
  process.exit(1);
};
process.on('uncaughtException', (e) => fail(e.message));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  log(`saved ${name}.png`);
};
/** Waits for `ok` in the page, up to `ms`. */
const until = async (what, ok, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.evaluate(ok)) return true;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

if (existsSync(modDir)) await fail(`${modDir} is already there: not overwriting it.`);
mkdirSync(modDir, { recursive: true });
writeFileSync(path.join(modDir, 'main.tsx'), MOD_SOURCE);
await until('the test mod to load', async () => (await import('/src/host/index.ts')).read().components.some((c) => c.name === 'attach_check'), 60_000).catch((e) => fail(e.message));

const opened = await openRace(page, { sessionKey: flag('session', null) == null ? null : Number(flag('session')), year: Number(flag('year', 2026)) }).catch((e) => fail(e.message));
log(`opened ${opened.title}`);
await seekToLap(page, opened.start ?? 600, Number(flag('lap', 30)));
const [leader, second] = await frontRunners(page);
log(`leader #${leader}, second #${second}`);

// The leader's tile throws: it has no car ahead. The second's draws.
const [broken, fine] = await page.evaluate(
  async ({ leader, second }) => {
    const { host } = await import('/src/host/index.ts');
    return host.layout.add({ items: [{ type: 'attach_check', props: { drivers: [leader] } }, { type: 'attach_check', props: { drivers: [second] } }] });
  },
  { leader, second },
);
await until('the leader tile to throw', async () => (await import('/src/host/index.ts')).read().health.some((p) => p.state === 'error'), 30_000).catch((e) => fail(e.message));
const place = await page.evaluate(async (id) => (await import('/src/host/index.ts')).read().health.find((p) => p.scope === id), broken);
check('the leader tile threw, with the moment it did', place?.state === 'error' && place.since != null, `${place?.message} at ${place?.since?.clockSec}`);
check('the other tile draws', await page.evaluate(async (id) => (await import('/src/host/index.ts')).read().health.find((p) => p.scope === id)?.state === 'drawn', fine));
check('only the broken tile has the button', (await page.locator('[data-testid=attach-error]').count()) === 1);
await shot('1-tile-error');

await page.locator('[data-testid=attach-error]').click();
await page.waitForSelector('[data-testid=attach-tray]');
check('attaching opens the tray with the tile', (await page.locator('[data-testid=attach-tray] [data-testid=attach-tag]').innerText()).includes(broken));
check('the input has focus', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'palette-input'));

if (!agent) {
  await page.keyboard.type('broke when he took the lead');
  await shot('2-tray');

  // Catch what would go to the agent in place of sending it.
  await page.evaluate(async () => {
    const { host } = await import('/src/host/index.ts');
    window.__sent = [];
    host.agent.status = async () => ({ ready: true });
    host.agent.send = async (text) => void window.__sent.push(text);
    host.account.status = async () => ({ f1tv: { signedIn: true } });
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const [text] = await page.evaluate(() => window.__sent);
  check('the message is the error block, then the words', /^<error>\n[\s\S]*"tile": "tile-\d+"[\s\S]*"first_threw"[\s\S]*"log": "attach_check\/mod.log"[\s\S]*\n<\/error>\n\nbroke when he took the lead$/.test(text ?? ''), text?.slice(0, 80));
  check('sending empties the tray', (await page.locator('[data-testid=attach-tray]').count()) === 0);
  await shot('3-sent');

  // As offer_build would leave it.
  await page.evaluate(async (id) => {
    const { host } = await import('/src/host/index.ts');
    host.build.offer({ tiles: [id], note: 'attach_check names the car ahead, and the leader has none. Its props are fine.' });
  }, broken);
  await page.waitForSelector('[data-testid=build-offer]');
  check('the offer takes focus on Switch to build', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'offer-switch'));
  await shot('4-offer');
  await page.keyboard.press('Escape');
  check('Esc stays in view mode', (await page.locator('[data-testid=build-offer]').count()) === 0 && !(await page.evaluate(async () => (await import('/src/host/index.ts')).read().build.active)));
} else {
  // No words: the error alone goes to the viewing agent, which should offer build mode.
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=build-offer]', { timeout: 180_000 }).catch(() => fail('The viewing agent never offered build mode.'));
  await until('the viewing turn to end', async () => !(await import('/src/host/index.ts')).read().agentBusy, 120_000);
  await shot('2-offer');
  await page.locator('[data-testid=offer-switch]').click();
  await until('build mode', async () => (await import('/src/host/index.ts')).read().build.active, 30_000);
  await until('the build agent to start', async () => (await import('/src/host/index.ts')).read().agentBusy, 30_000);
  await shot('3-switched');
  await until('the build turn to end', async () => !(await import('/src/host/index.ts')).read().agentBusy, 600_000);
  const after = await page.evaluate(async (id) => (await import('/src/host/index.ts')).read().health.find((p) => p.scope === id), broken);
  check('the leader tile draws after the build agent', after?.state === 'drawn', after?.state === 'drawn' ? '' : `${after?.state}: ${after?.message}`);
  await shot('4-fixed');
}

console.log(`\n${failures ? `${failures} failed` : 'all ok'}. Palette:\n${await page.locator('[data-testid=palette-history]').innerText().catch(() => '')}`);
await cleanUp();
process.exit(failures ? 1 : 0);
