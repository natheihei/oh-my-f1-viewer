// Run during a live session, against a packaged OMFV as a release installs it: opens the live session through
// the agent and checks DRM, the live edge, a second stream, the capture, DVR and going back to live. A packaged
// app has no source to import, so this reads the page and `window.omfv` only. Prints health data and row
// counts, no race information. Runs on an isolated profile like the other checks (see isolated.mjs). Needs both sign-ins.
//
// Usage: node scripts/packaged-live-check.mjs <screenshot-dir> [app]
//   app: the packaged executable. Defaults to the installed app on macOS, or what `npm run dist` left in release/.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { startElectron } from './platform.mjs';
import { prepareProfile, profileInUse, syncAgentLogin } from './isolated.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = process.argv[2] && path.resolve(process.argv[2]);
if (!outDir) throw new Error('Usage: node scripts/packaged-live-check.mjs <screenshot-dir> [app]');
mkdirSync(outDir, { recursive: true });

const DEFAULT_APP = {
  linux: path.join(root, 'release', 'linux-unpacked', 'oh-my-f1-viewer'),
  darwin: '/Applications/oh-my-f1-viewer.app/Contents/MacOS/oh-my-f1-viewer',
}[process.platform];
const bin = path.resolve(process.argv[3] ?? DEFAULT_APP ?? '');
if (!existsSync(bin)) throw new Error(`No packaged app at ${bin}: install a release or name one.`);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = netServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const until = async (what, ok, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await ok().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(what);
};

const userData = prepareProfile(mkdtempSync(path.join(outDir, 'user-data-')), { agent: true });
if (profileInUse(userData)) throw new Error(`Another OMFV is using ${userData}.`);
const settingsFile = path.join(userData, 'omfv-settings.json');
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
writeFileSync(settingsFile, JSON.stringify({ ...settings, ui: { ...settings.ui, volume: { level: 0, lastHeard: 1 } } }, null, 2));

const cdpPort = await freePort();
const mainLog = path.join(outDir, 'main.log');
const child = startElectron([`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], { bin, log: mainLog });
console.log(`${bin}\n  devtools on ${cdpPort}, user data in ${userData}, output in ${mainLog}`);

const ownPids = () => {
  try {
    return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
  } catch {
    return [];
  }
};

let browser = null;
const stop = async () => {
  await browser?.close().catch(() => {});
  for (const pid of ownPids()) {
    try {
      process.kill(pid);
    } catch {}
  }
  child?.kill();
  await until('The app never exited', async () => ownPids().length === 0, 15_000).catch(() => {});
  syncAgentLogin(userData);
};

try {
  browser = await until('The app never opened its devtools port', () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`));
  const page = await until('The app window never loaded: on macOS a keychain prompt holds it', async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('file:')));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const errors = new Set();
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || /\[stream\]/.test(t)) && !errors.has(t)) {
      errors.add(t);
      console.log('[console]', t.slice(0, 240));
    }
  });
  await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
  const shot = (name) => page.screenshot({ path: path.join(outDir, name), timeout: 10_000 }).then(() => console.log(`  screenshot: ${path.join(outDir, name)}`), (e) => console.log(`  no screenshot ${name}: ${e.message.split('\n')[0]}`));

  await page.evaluate(() => {
    window.events = [];
    window.omfv.ai.onEvent((e) => window.events.push(e));
    window.lastStatus = null;
    window.omfv.data.onStatus((s) => { window.lastStatus = s; });
  });

  const version = await page.evaluate(() => window.omfv.app.version());
  check('packaged', version.packaged, JSON.stringify(version));
  const f1tv = await page.evaluate(() => window.omfv.f1tv.status());
  check("F1 TV's copied sign-in decrypts", f1tv.signedIn);
  const ai = await page.evaluate(() => window.omfv.ai.status());
  check("the agent's copied login decrypts", ai.ready, ai.modelName ?? '');

  const live = await page.evaluate(() => window.omfv.f1tv.liveNow());
  console.log('F1 TV live now:', JSON.stringify(live.map((i) => ({ contentId: i.contentId, title: i.title, sessionKey: i.sessionKey }))));
  check('F1 TV reports something live', live.length > 0);

  const input = page.locator('[data-testid=palette-input]');
  async function say(text, { answer = null } = {}) {
    console.log(`> ${text}`);
    await page.evaluate(() => { window.events.length = 0; });
    if (!(await input.isVisible())) await page.keyboard.press('Control+K');
    await input.fill(text);
    await input.press('Enter');
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await page.evaluate(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'))) break;
      if (answer) {
        const button = await page.$(`[data-testid="spoiler-${answer}"]`);
        if (button) {
          await button.click().catch(() => {});
          console.log(`  spoiler check: ${answer}`);
        }
      }
      await page.waitForTimeout(400);
    }
    const events = await page.evaluate(() => window.events);
    const err = events.find((e) => e.type === 'error');
    if (err) console.log('  ERROR', err.message);
    console.log('  tools:', events.filter((e) => e.type === 'tool_start').map((e) => e.name).join(' ') || 'none');
    if (process.env.SHOW_REPLIES) console.log('  reply:', events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('').slice(0, 300));
    return events;
  }

  const sample = () =>
    page.evaluate(() => ({
      title: document.querySelector('[data-testid=session-title]')?.textContent ?? null,
      live: !!document.querySelector('.timeline-live'),
      atEdge: !!document.querySelector('.timeline-live-on'),
      streams: [...document.querySelectorAll('video.stream-video')].map((v) => {
        const q = v.getVideoPlaybackQuality();
        const end = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null;
        const holder = v.closest('[data-testid=video]');
        return { feed: holder?.dataset.feed, status: holder?.dataset.status, t: +v.currentTime.toFixed(2), behind: end == null ? null : +(end - v.currentTime).toFixed(1), encrypted: !!v.mediaKeys, ready: v.readyState, frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, size: `${v.videoWidth}x${v.videoHeight}`, paused: v.paused };
      }),
    }));
  const show = (label, s) => {
    console.log(`--- ${label}: live=${s.live} atEdge=${s.atEdge}`);
    const t0 = s.streams[0]?.t ?? 0;
    for (const x of s.streams) console.log(`  ${String(x.feed).padEnd(10)} ${String(x.status).padEnd(9)} drift=${(x.t - t0).toFixed(3)} behind=${x.behind} encrypted=${x.encrypted} ready=${x.ready} frames=${x.frames} dropped=${x.dropped} ${x.size}`);
  };
  const spread = (s) => Math.max(...s.streams.map((x) => x.t)) - Math.min(...s.streams.map((x) => x.t));
  const untilReady = (n, ms = 90_000) => until(`${n} stream(s) never ready`, async () => {
    const s = await sample();
    return s.streams.length >= n && s.streams.every((x) => x.status === 'ready' && x.frames > 30) ? s : null;
  }, ms).catch(() => null);

  await say('Open the session that is live now.');
  let s = await untilReady(1);
  check('the agent opened the live session and its main feed plays', !!s && s.live, s ? s.title : JSON.stringify(await sample()));
  if (!s) throw new Error('no live stream played: see main.log');
  show('main', s);
  check('main stream uses DRM', s.streams[0].encrypted);
  check('joined behind the live edge, not on top of it', s.streams[0].behind >= 5 && s.streams[0].behind < 20, `${s.streams[0].behind}s behind`);
  await page.waitForTimeout(5000);
  const later = await sample();
  check('live position advances and frames decode', later.streams[0].t > s.streams[0].t + 3 && later.streams[0].frames > s.streams[0].frames, `${s.streams[0].t} -> ${later.streams[0].t}`);
  await shot('packaged-live-main.png');

  // Suggested tiles, added from the strip with Enter.
  await say("Suggest Hamilton's onboard and Leclerc's onboard.");
  const offered = await until('no suggestion in the strip', async () => (await page.locator('[data-testid=suggestion]').count()) || null, 20_000).catch(() => 0);
  check('the agent suggested tiles', offered > 0, `${offered} in the strip`);
  for (let i = 0; i < offered; i += 1) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
  }
  s = await untilReady(1 + Math.min(offered, 2), 120_000);
  check('the added onboards play beside the main feed', !!s, JSON.stringify((await sample()).streams.map((x) => `${x.feed}:${x.status}`)));
  await page.waitForTimeout(15_000);
  s = await sample();
  show('15s later', s);
  check('every stream uses DRM', s.streams.every((x) => x.encrypted));
  check('live streams stay in sync', spread(s) < 0.5, `spread ${spread(s).toFixed(3)}s`);
  await shot('packaged-live-streams.png');

  // The capture: counts only, read past the playhead, so nothing of the race is printed.
  const captured = await until('the data never got ready', async () => {
    const st = await page.evaluate(() => window.lastStatus);
    return st?.state === 'ready' ? st : null;
  }, 150_000).catch(() => null);
  check('live data reaches the database', captured?.coverage?.source === 'live', JSON.stringify(captured && { state: captured.state, source: captured.coverage?.source, gaps: captured.coverage?.gaps?.length }));
  if (captured) {
    const tables = ['drivers', 'laps', 'position', 'intervals', 'stints', 'pit', 'race_control', 'weather', 'car_data', 'location'];
    const counts = await page.evaluate(async ({ key, tables }) => {
      const out = {};
      for (const t of tables) {
        try {
          out[t] = (await window.omfv.data.sql(key, Number.MAX_SAFE_INTEGER, `SELECT COUNT(*) AS n FROM ${t}`, [])).rows[0].n;
        } catch (e) {
          out[t] = `error: ${e.message}`.slice(0, 80);
        }
      }
      return out;
    }, { key: captured.sessionKey, tables });
    console.log('rows captured:', JSON.stringify(counts));
    check('a race fills intervals, laps and position', ['intervals', 'laps', 'position'].every((t) => counts[t] > 0));
    check('car telemetry is captured', counts.car_data > 0 && counts.location > 0);
  }

  // DVR: three minutes back by the keyboard, then back to live by the timeline's button.
  if (await input.isVisible()) await page.keyboard.press('Control+K');
  const before = (await sample()).streams[0].t;
  for (let i = 0; i < 18; i += 1) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(12_000);
  s = await sample();
  show('12s after going back 3 minutes', s);
  check('DVR seek landed', Math.abs(s.streams[0].t - (before - 180 + 15)) < 12, `from ${before} to ${s.streams[0].t}`);
  check('no longer at the live edge', !s.atEdge);
  check('streams followed the DVR seek', spread(s) < 0.7 && s.streams.every((x) => x.status === 'ready'), `spread ${spread(s).toFixed(3)}s`);
  await page.locator('.timeline-live').click();
  await page.waitForTimeout(12_000);
  s = await sample();
  show('12s after go live', s);
  check('returns to the live edge', s.atEdge, `${s.streams[0].behind}s behind`);
  check('streams followed back to live', spread(s) < 0.7 && s.streams.every((x) => x.status === 'ready'), `spread ${spread(s).toFixed(3)}s`);

  // Pause and resume, by the keyboard.
  await page.keyboard.press('Space');
  await page.waitForTimeout(4000);
  const paused = await sample();
  await page.keyboard.press('Space');
  await page.waitForTimeout(8000);
  s = await sample();
  check('pause holds, then resume plays on', paused.streams.every((x) => x.paused) && s.streams[0].t > paused.streams[0].t + 4, `${paused.streams[0].t} -> ${s.streams[0].t}`);

  // The world feed and charts on race data, suggested by the agent and added from the strip.
  const addSuggested = async (text) => {
    await say(text);
    const n = await until('no suggestion in the strip', async () => (await page.locator('[data-testid=suggestion]').count()) || null, 20_000).catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    }
    return n;
  };
  const world = await addSuggested('Suggest the world feed.');
  s = await untilReady(4, 90_000);
  check('the world feed plays on a live race, under DRM', world > 0 && !!s && s.streams.every((x) => x.encrypted), JSON.stringify((await sample()).streams.map((x) => `${x.feed}:${x.status}:${x.encrypted}`)));
  if (s) check('four live streams in sync', spread(s) < 0.5, `spread ${spread(s).toFixed(3)}s`);
  const charts = await addSuggested('Suggest the timing tower, the track map and a gap chart for the top two.');
  await page.waitForTimeout(20_000);
  const tiles = await page.evaluate(() => {
    // A component may draw inside a shadow root, which innerText and querySelectorAll don't enter.
    const walk = (node, into) => {
      for (const el of node.querySelectorAll('*')) {
        into.elements += 1;
        if (el.shadowRoot) walk(el.shadowRoot, into);
      }
      for (const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); w.nextNode(); ) into.chars += w.currentNode.textContent.trim().length;
      return into;
    };
    return [...document.querySelectorAll('.stage-host[data-tile-type]')].map((h) => {
      // Shape only: how much it drew, never what.
      const { elements, chars } = walk(h, { elements: 0, chars: 0 });
      return {
        type: h.dataset.tileType,
        chars,
        drawn: elements,
        // The charts draw on a canvas: a blank one encodes to far less than a drawn one.
        canvas: Math.max(0, ...[...h.querySelectorAll('canvas')].map((c) => { try { return c.toDataURL().length; } catch { return -1; } })),
        error: h.querySelector('.tile-status-error, [data-testid=tile-error]')?.textContent?.slice(0, 120) ?? null,
        status: h.querySelector('[data-testid=tile-status]')?.textContent?.slice(0, 120) ?? null,
      };
    });
  });
  for (const t of tiles) console.log(`  tile ${String(t.type).padEnd(16)} chars=${t.chars} drawn=${t.drawn} canvas=${t.canvas}${t.status ? ` status: ${t.status}` : ''}${t.error ? ` ERROR: ${t.error}` : ''}`);
  const drawn = tiles.filter((t) => !['video', 'stream'].includes(t.type));
  check('the suggested charts drew on live race data', charts > 0 && drawn.length > 0 && drawn.every((t) => !t.error && (t.canvas > 5000 || t.drawn > 10)), `${charts} suggested, ${drawn.length} chart tile(s)`);

  // Back to live through the agent, from two minutes behind: it asks first, as a forward seek.
  await say('Go back 2 minutes.');
  await page.waitForTimeout(8000);
  s = await sample();
  check('the agent went back on the live timeline', !s.atEdge, `${s.streams[0].behind}s behind`);
  const back = await say('Back to live.', { answer: 'once' });
  await page.waitForTimeout(12_000);
  s = await sample();
  check('go_live returns to the edge after Allow once', back.some((e) => e.type === 'tool_start' && e.name === 'go_live') && s.atEdge, `${s.streams[0].behind}s behind`);
  await shot('packaged-live-end.png');
} catch (e) {
  check('the check ran', false, e.message);
} finally {
  await stop();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
