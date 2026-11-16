// Asks the real agent for sessions the way a viewer does, with nothing open, each request in a fresh
// conversation, a few times over: whether it opens the one meant, or asks when the words could mean
// several. Nothing is played: load_session is stubbed, so the run reads no race and plays no video.
// Runs on ~/.config/f1a for the agent's login (see scripts/isolated.mjs), and refuses while another f1a
// is using it.
//
// Usage: node scripts/picking-check.mjs <out-dir> [--runs 3] ["request" ...]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startIsolatedApp } from './isolated.mjs';
import { typeInPalette } from './harness.mjs';

const argv = process.argv.slice(2);
const outDir = argv[0];
if (!outDir) throw new Error('Usage: node scripts/picking-check.mjs <out-dir> [--runs 3] ["request" ...]');
mkdirSync(outDir, { recursive: true });
const runsAt = argv.indexOf('--runs');
const runs = runsAt > 0 ? Number(argv[runsAt + 1]) : 3;
const given = argv.slice(1).filter((a, i, all) => a !== '--runs' && all[i - 1] !== '--runs');
const requests = given.length ? given : ['last race', 'latest quali', '2026', '2025 Mexico'];

const { page, stop } = await startIsolatedApp(path.resolve(outDir), { name: 'picking', mainProfile: true });
try {
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    const { AGENT_TOOLS } = await import('/src/agent/tools.ts');
    window.events = [];
    window.f1a.ai.onEvent((e) => window.events.push(e));
    // Opening the session isn't what's checked, only which one: record it and play nothing.
    window.opened = [];
    AGENT_TOOLS.find((t) => t.name === 'load_session').run = async (args) => {
      window.opened.push(args);
      return JSON.stringify({ opened: args.title, playingFrom: 'start' });
    };
    await host.catalog.loadIndex();
    if (read().events.state !== 'ready') throw new Error(`Events didn't load: ${read().events.error}`);
  });
  if (!(await page.evaluate(async () => (await window.f1a.ai.status()).ready))) throw new Error('The agent is not signed in in ~/.config/f1a.');

  const results = [];
  for (const request of requests) {
    for (let run = 1; run <= runs; run += 1) {
      await page.evaluate(async () => {
        window.events.length = 0;
        window.opened.length = 0;
        await window.f1a.ai.reset();
      });
      await typeInPalette(page, request);
      await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 180_000 });
      await page.waitForTimeout(1000);
      const { events, opened } = await page.evaluate(() => ({ events: window.events, opened: window.opened }));
      const error = events.find((e) => e.type === 'error');
      const calls = events.filter((e) => e.type === 'tool_start').map((e) => `${e.name}(${JSON.stringify(e.args)})`);
      const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
      const outcome = error ? `error: ${error.message}` : opened.length ? `opened ${opened.map((o) => o.title ?? o.contentId).join(', ')}` : `asked: ${reply}`;
      results.push({ request, run, outcome });
      console.log(`\n> ${request} (run ${run})`);
      for (const call of calls) console.log(`  tool: ${call.slice(0, 160)}`);
      console.log(`  ${outcome}`);
    }
  }
  console.log('\nSummary');
  for (const { request, run, outcome } of results) console.log(`  ${request} #${run}: ${outcome.slice(0, 140)}`);
} finally {
  await stop();
}
