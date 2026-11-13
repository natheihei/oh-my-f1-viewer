// Checks the "more" mark a tile shows when its content is cut off below or at the right, in the real app
// with no sign-in. A list mod in a fresh profile, on the grid at its size.min, below it, with many rows,
// scrolled to the end, and in the suggestion strip; then a wide table mod cut at the right, scrolled to its
// right end, cut both ways, and a line cut short with "…". Saves a screenshot of each.
//
// The app is launched through Hyprland on workspace 3, floating and without focus, and driven over CDP, so
// it never takes over the screen. Usage: node scripts/overflow-check.mjs [screenshot-dir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

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
  size: { aspect: 2, min: { width: 400, height: 100 } },
  spec: (props) => ({ key: '${NAME}-' + (props.rows ?? 4), label: 'race control (' + (props.rows ?? 4) + ')' }),
  View: List,
});
`,
);

// A table wider than most tiles, scrolling sideways, and a line that ends in "…" instead.
const WIDE = 'wide_table';
mkdirSync(path.join(userData, 'mods', WIDE), { recursive: true });
writeFileSync(
  path.join(userData, 'mods', WIDE, 'main.tsx'),
  `import Type from 'typebox';
import { defineComponent } from 'f1a';

const COLS = ['P', 'DRV', 'GAP', 'INT', 'LAST', 'BEST', 'S1', 'S2', 'S3', 'SPEED', 'TYRE', 'AGE', 'PITS'];

function Wide({ props }: { props: { rows?: number; ellipsis?: boolean } }) {
  if (props.ellipsis)
    return (
      <div style={{ padding: '2px 6px', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {'INCIDENT INVOLVING CARS 4 AND 16 AT TURN 1 NOTED, UNDER INVESTIGATION AFTER THE RACE FOR CAUSING A COLLISION'}
      </div>
    );
  const rows = Array.from({ length: props.rows ?? 4 }, (_, i) => i);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div data-list style={{ flex: 1, minHeight: 0, overflow: 'auto', fontSize: 11, lineHeight: '18px' }}>
        <table style={{ width: 900, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
          <thead><tr>{COLS.map((c) => <th key={c} style={{ textAlign: 'left', color: '#767676', fontWeight: 400, padding: '0 6px' }}>{c}</th>)}</tr></thead>
          <tbody>{rows.map((i) => <tr key={i}>{COLS.map((c, j) => <td key={c} style={{ padding: '0 6px', color: j % 2 ? '#8a8a8a' : '#e7e7e7' }}>{j === 0 ? i + 1 : c.toLowerCase() + ' ' + (i + 1)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

export default defineComponent({
  name: '${WIDE}',
  title: 'Wide table',
  description: 'A test table wider than most tiles.',
  args: Type.Object({ rows: Type.Optional(Type.Number()), ellipsis: Type.Optional(Type.Boolean()) }),
  size: { aspect: 3, min: { width: 300, height: 100 } },
  spec: (props) => ({ key: '${WIDE}-' + (props.ellipsis ? 'ellipsis' : props.rows ?? 4), label: 'wide (' + (props.ellipsis ? '…' : props.rows ?? 4) + ')' }),
  View: Wide,
});
`,
);

const server = await createServer({ server: { port: 5196, strictPort: true }, logLevel: 'error' });
await server.listen();
const CDP = 9336;
const electronBin = path.resolve('node_modules/electron/dist/electron');
const cmd = `env ELECTRON_START_URL=http://127.0.0.1:5196 ${electronBin} ${path.resolve('.')} --user-data-dir=${userData} --remote-debugging-port=${CDP}`;
execFileSync('hyprctl', ['eval', `hl.exec_cmd(${JSON.stringify(cmd)}, { workspace = "3 silent", float = true, size = "1600 900", no_initial_focus = true })`]);
let browser;
for (let i = 0; i < 120 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null);
  if (!browser) await new Promise((r) => setTimeout(r, 500));
}
if (!browser) throw new Error('the app did not open its debugging port');
let page;
for (let i = 0; i < 120 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1:5196'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
// A hidden workspace stops producing frames when nothing moves, which stalls screenshots.
const keepFrames = () =>
  page.evaluate(() => {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;z-index:99999;pointer-events:none;animation:f1a-tick 1s linear infinite';
    const style = document.createElement('style');
    style.textContent = '@keyframes f1a-tick{from{opacity:.01}to{opacity:.02}}';
    document.head.append(style);
    document.body.append(dot);
  });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const settle = () => page.waitForTimeout(400);

await page.waitForSelector('[data-testid=palette]');
await keepFrames();
await page.evaluate(async () => {
  const [{ host, read }, { layout }] = await Promise.all([import('/src/host/index.ts'), import('/src/layout/store.ts')]);
  Object.assign(window, { host, read, layout });
});
const deadline = Date.now() + 30_000;
const ready = (names) => page.evaluate((names) => names.every((n) => window.read().mods.some((m) => m.name === n && m.state === 'ready')), names);
while (Date.now() < deadline && !(await ready([NAME, WIDE]))) await page.waitForTimeout(250);
check('the test mods load', await ready([NAME, WIDE]));

const host = (key) => page.locator(`.stage-host[data-tile-key="${key}"]`);
const marked = async (key) => (await host(key).locator('[data-testid=overflow-mark]').count()) === 1;
const markText = (key) => host(key).locator('[data-testid=overflow-mark]').innerText().catch(() => '');
const shot = async (key, name) => {
  const box = await host(key).boundingBox();
  await page.screenshot({ path: path.join(outDir, name), clip: { x: box.x - 4, y: box.y - 22, width: box.width + 8, height: box.height + 26 } });
};
async function place(rows, rect, name = NAME) {
  const key = `${name}-${rows}`;
  const tile = await page.evaluate((key) => window.layout.tiles().find((t) => t.component.key === key)?.id, key);
  await page.evaluate(({ tile, rect }) => window.host.layout.move({ tile, rect }), { tile, rect });
  await settle();
  return key;
}

await page.evaluate((n) => window.host.layout.add({ items: [{ type: n, props: { rows: 8 } }, { type: n, props: { rows: 40 } }] }), NAME);
await settle();

let key = await place(8, { x: 0, y: 0, w: 6, h: 5 });
check('with room for all 8 rows, there is no mark', !(await marked(key)));
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

await page.evaluate(() => window.host.suggestions.offer({ items: [] })).catch(() => {});

// Sideways: a 900px table, 4 rows that fit in height.
await page.evaluate(
  (n) => window.host.layout.add({ items: [{ type: n, props: { rows: 4 } }, { type: n, props: { rows: 30 } }, { type: n, props: { ellipsis: true } }] }),
  WIDE,
);
await settle();

key = await place(4, { x: 0, y: 0, w: 16, h: 4 }, WIDE);
check('a table that fits sideways is not marked', !(await marked(key)), `${await host(key).evaluate((el) => el.clientWidth)}px wide`);
await shot(key, 'overflow-7-wide-fits.png');

key = await place(4, { x: 0, y: 0, w: 6, h: 4 }, WIDE);
check('a table cut at the right is marked "more ▸"', (await markText(key)).replace(/\s+/g, ' ').trim().toLowerCase() === 'more ▸', await markText(key));
await shot(key, 'overflow-8-wide-cut.png');

await host(key).locator('[data-list]').evaluate((el) => (el.scrollLeft = el.scrollWidth));
await settle();
check('scrolled to its right end, the mark goes', !(await marked(key)));
await shot(key, 'overflow-9-wide-scrolled.png');

key = await place(30, { x: 8, y: 0, w: 6, h: 4 }, WIDE);
check('a table cut both ways is marked "more ▾▸"', (await markText(key)).replace(/\s+/g, ' ').trim().toLowerCase() === 'more ▾▸', await markText(key));
await shot(key, 'overflow-10-wide-and-tall.png');

key = await place('ellipsis', { x: 16, y: 0, w: 5, h: 3 }, WIDE);
const cut = await host(key).locator('[data-list], div[style*="ellipsis"]').first().evaluate((el) => el.scrollWidth > el.clientWidth).catch(() => false);
check('a line cut short with "…" is not marked', !(await marked(key)), cut ? 'the line is cut' : 'the line was not cut');
await shot(key, 'overflow-11-ellipsis.png');

console.log(failures ? `${failures} failed` : 'all ok', `screenshots in ${outDir}`);
await browser.close().catch(() => {});
try {
  execFileSync('pkill', ['-f', '--', `--user-data-dir=${userData}`]);
} catch {}
await server.close();
process.exit(failures ? 1 : 0);
