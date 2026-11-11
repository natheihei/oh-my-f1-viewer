// Checks the "more ▾" mark a tile shows when its content is cut off below, in the real app with no
// sign-in: a list mod in a fresh profile, on the grid at its size.min, below it, with many rows, scrolled
// to the end, and in the suggestion strip. Saves a screenshot of each.
// Usage: node scripts/overflow-check.mjs [screenshot-dir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { _electron as electron } from 'playwright';

const outDir = process.argv[2] ?? tmpdir();
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(tmpdir(), 'f1a-overflow-'));

// A list like the one that found the problem: no heading, its rows in a scrolling area.
const NAME = 'rc_list';
mkdirSync(path.join(userData, 'mods', NAME), { recursive: true });
writeFileSync(
  path.join(userData, 'mods', NAME, 'main.tsx'),
  `import Type from 'typebox';
import { defineComponent } from 'f1a';

const MESSAGES = ['YELLOW IN SECTOR 2', 'CLEAR IN SECTOR 2', 'DRS ENABLED', 'TRACK LIMITS T4', 'BLUE FLAG', 'INCIDENT T1 NOTED'];

function List({ props }: { props: { rows?: number } }) {
  const rows = Array.from({ length: props.rows ?? 4 }, (_, i) => i);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div data-list style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px 6px', fontSize: 11, lineHeight: '16px' }}>
        {rows.map((i) => (
          <div key={i} style={{ whiteSpace: 'nowrap' }}>
            <span style={{ color: '#8a8a8a', marginRight: 6 }}>{i + 1}</span>
            {MESSAGES[i % MESSAGES.length]}
          </div>
        ))}
      </div>
    </div>
  );
}

export default defineComponent({
  name: '${NAME}',
  title: 'Race control list',
  description: 'A test list of messages.',
  args: Type.Object({ rows: Type.Optional(Type.Number()) }),
  size: { aspect: 2, min: [6, 3] },
  spec: (props) => ({ key: '${NAME}-' + (props.rows ?? 4), label: 'race control (' + (props.rows ?? 4) + ')' }),
  View: List,
});
`,
);

const server = await createServer({ server: { port: 5196, strictPort: true }, logLevel: 'error' });
await server.listen();
const { CHROME_DESKTOP: _ignored, ...env } = process.env;
const app = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['.', `--user-data-dir=${userData}`],
  env: { ...env, ELECTRON_START_URL: 'http://127.0.0.1:5196' },
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const settle = () => page.waitForTimeout(400);

await page.waitForSelector('[data-testid=palette]');
await page.evaluate(async () => {
  const [{ host, read }, { layout }] = await Promise.all([import('/src/host/index.ts'), import('/src/layout/store.ts')]);
  Object.assign(window, { host, read, layout });
});
const deadline = Date.now() + 30_000;
while (Date.now() < deadline && !(await page.evaluate((n) => window.read().mods.some((m) => m.name === n && m.state === 'ready'), NAME)))
  await page.waitForTimeout(250);
check('the list mod loads', await page.evaluate((n) => window.read().mods.some((m) => m.name === n && m.state === 'ready'), NAME));

const host = (key) => page.locator(`.stage-host[data-tile-key="${key}"]`);
const marked = async (key) => (await host(key).locator('[data-testid=overflow-mark]').count()) === 1;
const shot = async (key, name) => {
  const box = await host(key).boundingBox();
  await page.screenshot({ path: path.join(outDir, name), clip: { x: box.x - 4, y: box.y - 22, width: box.width + 8, height: box.height + 26 } });
};
async function place(rows, rect) {
  const key = `${NAME}-${rows}`;
  const tile = await page.evaluate((key) => window.layout.tiles().find((t) => t.component.key === key)?.id, key);
  await page.evaluate(({ tile, rect }) => window.host.layout.move({ tile, rect }), { tile, rect });
  await settle();
  return key;
}

await page.evaluate((n) => window.host.layout.add({ items: [{ type: n, props: { rows: 8 } }, { type: n, props: { rows: 40 } }] }), NAME);
await settle();

let key = await place(8, { x: 0, y: 0, w: 6, h: 3 });
check('at size.min, 8 rows fit and there is no mark', !(await marked(key)));
await shot(key, 'overflow-1-fits-at-min.png');

key = await place(8, { x: 0, y: 0, w: 6, h: 2 });
check('below size.min, the cut-off list is marked', await marked(key));
await shot(key, 'overflow-2-below-min.png');

key = await place(8, { x: 0, y: 0, w: 6, h: 1 });
const listHeight = await host(key).locator('[data-list]').evaluate((el) => el.clientHeight);
check('with its scroll area squeezed to almost nothing, it is marked', await marked(key), `list ${listHeight}px tall`);
await shot(key, 'overflow-3-squeezed.png');

key = await place(40, { x: 8, y: 0, w: 6, h: 3 });
check('many rows at size.min are marked', await marked(key));
await shot(key, 'overflow-4-many-rows.png');

await host(key).locator('[data-list]').evaluate((el) => (el.scrollTop = el.scrollHeight / 3));
await settle();
check('scrolled part-way, it is still marked', await marked(key));
await host(key).locator('[data-list]').evaluate((el) => (el.scrollTop = el.scrollHeight));
await settle();
check('scrolled to the end, the mark goes', !(await marked(key)));
await shot(key, 'overflow-5-scrolled-to-end.png');

await page.evaluate((n) => window.host.layout.remove({ keys: [`${n}-8`, `${n}-40`] }), NAME);
await page.evaluate((n) => window.host.suggestions.offer({ items: [{ type: n, props: { rows: 40 } }, { type: n, props: { rows: 1 } }] }), NAME);
await settle();
const cards = page.locator('[data-testid=suggestion]');
const cardMarks = await cards.evaluateAll((els) => els.map((el) => [el.innerText.split('\n').pop(), el.querySelector('[data-testid=overflow-mark]') !== null]));
check('in the strip, the long list is marked', cardMarks.some(([, m]) => m), JSON.stringify(cardMarks));
check('in the strip, the one-row list is not', cardMarks.some(([, m]) => !m), JSON.stringify(cardMarks));
await page.locator('[data-testid=suggestion-strip]').screenshot({ path: path.join(outDir, 'overflow-6-strip.png') }).catch(async () => {
  const box = await cards.first().boundingBox();
  await page.screenshot({ path: path.join(outDir, 'overflow-6-strip.png'), clip: { x: 0, y: Math.max(0, box.y - 10), width: 900, height: box.height + 20 } });
});

console.log(failures ? `${failures} failed` : 'all ok', `screenshots in ${outDir}`);
await app.close();
await server.close();
process.exit(failures ? 1 : 0);
