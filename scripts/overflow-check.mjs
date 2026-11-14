// Checks the "more" mark a tile shows when its component has outgrown it, in the real app with no sign-in.
// The host looks only at the frame it draws a component in. A table mod that lets its content run past the
// tile is marked "more ▾", "more ▸" or "more ▾▸" by which way it runs, and not marked when it fits, on the
// grid and in the suggestion strip. A list that scrolls its own rows has handled its overflow, so it isn't
// marked however many rows it has. Saves a screenshot of each.
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

function writeMod(name, source) {
  mkdirSync(path.join(userData, 'mods', name), { recursive: true });
  writeFileSync(path.join(userData, 'mods', name, 'main.tsx'), source);
}

// A list that scrolls its own rows: it has handled its overflow.
const LIST = 'rc_list';
writeMod(
  LIST,
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
  name: '${LIST}',
  title: 'Race control list',
  description: 'A test list of messages.',
  args: Type.Object({ rows: Type.Optional(Type.Number()) }),
  size: { aspect: 2, min: { width: 400, height: 100 } },
  spec: (props) => ({ key: '${LIST}-' + (props.rows ?? 4), label: 'race control (' + (props.rows ?? 4) + ')' }),
  View: List,
});
`,
);

// A table that can't get smaller: its rows and columns run past the tile.
const TABLE = 'wide_table';
writeMod(
  TABLE,
  `import Type from 'typebox';
import { defineComponent } from 'f1a';

const ALL = ['P', 'DRV', 'GAP', 'INT', 'LAST', 'BEST', 'S1', 'S2', 'S3', 'SPEED', 'TYRE', 'AGE', 'PITS'];

function Table({ props }: { props: { rows?: number; cols?: number } }) {
  const cols = ALL.slice(0, props.cols ?? ALL.length);
  const rows = Array.from({ length: props.rows ?? 4 }, (_, i) => i);
  return (
    <table style={{ borderCollapse: 'collapse', whiteSpace: 'nowrap', fontSize: 11, lineHeight: '18px' }}>
      <thead><tr>{cols.map((c) => <th key={c} style={{ textAlign: 'left', color: '#767676', fontWeight: 400, padding: '0 6px', minWidth: 54 }}>{c}</th>)}</tr></thead>
      <tbody>{rows.map((i) => <tr key={i}>{cols.map((c, j) => <td key={c} style={{ padding: '0 6px', color: j % 2 ? '#8a8a8a' : '#e7e7e7' }}>{j === 0 ? i + 1 : c.toLowerCase() + ' ' + (i + 1)}</td>)}</tr>)}</tbody>
    </table>
  );
}

export default defineComponent({
  name: '${TABLE}',
  title: 'Table',
  description: 'A test table that runs past its tile.',
  args: Type.Object({ rows: Type.Optional(Type.Number()), cols: Type.Optional(Type.Number()) }),
  size: { aspect: 2, min: { width: 300, height: 100 } },
  spec: (props) => {
    const id = (props.rows ?? 4) + 'x' + (props.cols ?? 13);
    return { key: '${TABLE}-' + id, label: 'table (' + id + ')' };
  },
  View: Table,
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

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const settle = () => page.waitForTimeout(400);

await page.waitForSelector('[data-testid=palette]');
// A hidden workspace stops producing frames when nothing moves, which stalls screenshots.
await page.evaluate(() => {
  const style = document.createElement('style');
  style.textContent = '@keyframes f1a-tick{from{opacity:.01}to{opacity:.02}}';
  const dot = document.createElement('div');
  dot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;z-index:99999;pointer-events:none;animation:f1a-tick 1s linear infinite';
  document.head.append(style);
  document.body.append(dot);
});
await page.evaluate(async () => {
  const [{ host, read }, { layout }] = await Promise.all([import('/src/host/index.ts'), import('/src/layout/store.ts')]);
  Object.assign(window, { host, read, layout });
});
const ready = (names) => page.evaluate((names) => names.every((n) => window.read().mods.some((m) => m.name === n && m.state === 'ready')), names);
const deadline = Date.now() + 30_000;
while (Date.now() < deadline && !(await ready([LIST, TABLE]))) await page.waitForTimeout(250);
check('the test mods load', await ready([LIST, TABLE]));

const host = (key) => page.locator(`.stage-host[data-tile-key="${key}"]`);
/** The mark's text, like "more ▾▸", or '' when there's none. */
const mark = async (key) =>
  (await host(key).locator('[data-testid=overflow-mark]').innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ').trim().toLowerCase();
const shot = async (key, name) => {
  const box = await host(key).boundingBox();
  await page.screenshot({ path: path.join(outDir, name), clip: { x: box.x - 4, y: box.y - 22, width: box.width + 8, height: box.height + 26 } });
};
async function place(key, rect) {
  const tile = await page.evaluate((key) => window.layout.tiles().find((t) => t.component.key === key)?.id, key);
  await page.evaluate(({ tile, rect }) => window.host.layout.move({ tile, rect }), { tile, rect });
  await settle();
  return key;
}
const width = (key) => host(key).evaluate((el) => el.clientWidth);

// The table: 4 rows of 5 columns fit a 400px tile; 13 columns are about 900px wide.
await page.evaluate(
  (n) =>
    window.host.layout.add({
      items: [
        { type: n, props: { rows: 4, cols: 5 } },
        { type: n, props: { rows: 30, cols: 5 } },
        { type: n, props: { rows: 4, cols: 13 } },
        { type: n, props: { rows: 30, cols: 13 } },
      ],
    }),
  TABLE,
);
await settle();

let key = await place(`${TABLE}-4x5`, { x: 0, y: 0, w: 6, h: 5 });
check('a table that fits is not marked', (await mark(key)) === '', await mark(key));
await shot(key, 'fits.png');

key = await place(`${TABLE}-30x5`, { x: 6, y: 0, w: 6, h: 5 });
check('a table taller than its tile is marked "more ▾"', (await mark(key)) === 'more ▾', await mark(key));
await shot(key, 'below.png');

key = await place(`${TABLE}-4x13`, { x: 12, y: 0, w: 6, h: 5 });
check('a table wider than its tile is marked "more ▸"', (await mark(key)) === 'more ▸', `${await mark(key)}, tile ${await width(key)}px`);
await shot(key, 'right.png');

key = await place(`${TABLE}-30x13`, { x: 0, y: 5, w: 6, h: 5 });
check('a table past both edges is marked "more ▾▸"', (await mark(key)) === 'more ▾▸', await mark(key));
await shot(key, 'both.png');

key = await place(`${TABLE}-4x13`, { x: 6, y: 5, w: 18, h: 5 });
check('the wide table in a tile wide enough is not marked', (await mark(key)) === '', `${await mark(key)}, tile ${await width(key)}px`);

await page.evaluate((n) => window.host.layout.remove({ tiles: window.layout.tiles().filter((t) => t.component.type === n).map((t) => t.id) }), TABLE);

// The list scrolls its own rows, so however many it has, the host has nothing to mark.
await page.evaluate((n) => window.host.layout.add({ items: [{ type: n, props: { rows: 40 } }] }), LIST);
await settle();
key = await place(`${LIST}-40`, { x: 0, y: 0, w: 6, h: 3 });
check('a list that scrolls 40 rows is not marked', (await mark(key)) === '', await mark(key));
await shot(key, 'list-scrolls.png');
key = await place(`${LIST}-40`, { x: 0, y: 0, w: 6, h: 1 });
const listHeight = await host(key).locator('[data-list]').evaluate((el) => el.clientHeight);
check('nor when its scroll area is squeezed', (await mark(key)) === '', `list ${listHeight}px tall`);
await page.evaluate((n) => window.host.layout.remove({ tiles: window.layout.tiles().filter((t) => t.component.type === n).map((t) => t.id) }), LIST);

// The strip draws through the same frame.
await page.evaluate((n) => window.host.suggestions.offer({ items: [{ type: n, props: { rows: 30, cols: 13 } }, { type: n, props: { rows: 1, cols: 2 } }] }), TABLE);
await settle();
const cards = page.locator('[data-testid=suggestion]');
const cardMarks = await cards.evaluateAll((els) =>
  els.map((el) => [el.innerText.split('\n')[0], el.querySelector('[data-testid=overflow-mark]')?.textContent.replace(/\s+/g, ' ').trim().toLowerCase() ?? '']),
);
check('in the strip, the big table is marked', cardMarks.some(([, m]) => m === 'more ▾▸'), JSON.stringify(cardMarks));
check('in the strip, the small one is not', cardMarks.some(([, m]) => m === ''), JSON.stringify(cardMarks));
await page
  .locator('[data-testid=suggestion-strip]')
  .screenshot({ path: path.join(outDir, 'strip.png') })
  .catch(() => {});

console.log(failures ? `${failures} failed` : 'all ok', `screenshots in ${outDir}`);
await browser.close().catch(() => {});
try {
  execFileSync('pkill', ['-f', '--', `--user-data-dir=${userData}`]);
} catch {}
await server.close();
process.exit(failures ? 1 : 0);
