// Asks the real agent, with nothing open, for a session and a moment in it in one message, the way a viewer
// does: "2026 Mexico race, jump to green light". The profile is fresh, so the session's timing data has to be
// fetched and ingested while the turn runs. Checks that the tools wait for it rather than refuse, that the
// palette says so, and that playback ends up moved. A forward seek asks the viewer, and this allows it once.
// Then it opens the event's qualifying as the viewer would and asks for a moment at once, before its data is there.
// Shots of each step go to the out dir.
// Runs in an OMFV of its own with the logins copied in (see scripts/isolated.mjs). It plays the session.
//
// Usage: node scripts/data-wait-check.mjs <out-dir> ["request"]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startIsolatedApp } from './isolated.mjs';
import { typeInPalette } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/data-wait-check.mjs <out-dir> ["request"]');
mkdirSync(outDir, { recursive: true });
const request = process.argv[3] ?? '2026 mexico race, jump to green light';

const { page, stop } = await startIsolatedApp(path.resolve(outDir), { name: 'data-wait', agent: true });
let failed = false;
try {
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    const { lookAhead, useLookAhead } = await import('/src/shell/lookAhead.ts');
    window.events = [];
    // For waitForFunction, whose test can't await an import.
    window.usePalette = (await import('/src/shell/palette.ts')).usePalette;
    window.omfv.ai.onEvent((e) => window.events.push({ ...e, at: Date.now(), data: read().sessionData.state }));
    // The viewer's answer to the spoiler check: once.
    useLookAhead.subscribe((s) => s.asking && setTimeout(() => lookAhead.answer('once'), 500));
    await host.catalog.loadIndex();
    if (read().events.state !== 'ready') throw new Error(`Events didn't load: ${read().events.error}`);
  });
  if (!(await page.evaluate(async () => (await window.omfv.ai.status()).ready))) throw new Error('The agent is not set up in the main profile: connect it in /settings-agent.');

  const lines = () => page.evaluate(async () => (await import('/src/shell/palette.ts')).usePalette.getState().entries.map((e) => `${e.role}: ${e.text}`));
  const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
  /** Sends a request, with a shot of each palette line of the wait as it's drawn, and one when the turn is over. Returns whether it worked, and the turn's events. */
  const ask = async (label, text) => {
    await page.evaluate(() => (window.events.length = 0));
    const before = (await lines()).length;
    await typeInPalette(page, text);
    /** Waits for a line of this turn's, or for the turn to end without one. The pause lets it be drawn. */
    const line = async (source) => {
      const seen = await page
        .waitForFunction(
          ([from, pattern]) => {
            if (window.usePalette.getState().entries.slice(from).some((e) => new RegExp(pattern).test(e.text))) return 'line';
            return window.events.some((e) => e.type === 'turn_end' || e.type === 'error') ? 'over' : false;
          },
          [before, source],
          { timeout: 300_000 },
        )
        .then((h) => h.jsonValue());
      await page.waitForTimeout(200);
      return seen === 'line';
    };
    const waited = await line('timing data…');
    if (waited) await shot(`${label}-1-waiting`);
    if (waited && (await line('Timing data (loaded|lined up)\\.'))) await shot(`${label}-2-loaded`);
    await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 300_000 });
    await page.waitForTimeout(4000);
    await shot(`${label}-3-done`);

    const { events, clock, data } = await page.evaluate(async () => {
      const { read } = await import('/src/host/index.ts');
      return { events: [...window.events], clock: read().clock.timeSec, data: read().sessionData.state };
    });
    console.log(`\n> ${text}`);
    const start = events[0]?.at ?? 0;
    for (const e of events) {
      if (e.type === 'tool_start') console.log(`  +${((e.at - start) / 1000).toFixed(1)}s ${e.name}(${JSON.stringify(e.args).slice(0, 140)}) data: ${e.data}`);
      if (e.type === 'tool_end') console.log(`  +${((e.at - start) / 1000).toFixed(1)}s   ${e.ok ? 'ok' : 'FAILED'} data: ${e.data}`);
      if (e.type === 'error') console.log(`  error: ${e.message}`);
    }
    console.log('  Palette');
    for (const entry of (await lines()).slice(before)) console.log(`    ${entry}`);
    const ends = events.filter((e) => e.type === 'tool_end');
    const seeks = events.filter((e) => e.type === 'tool_start' && e.name === 'seek_to').length;
    console.log(`  waited in the palette: ${waited}, data: ${data}, playback at ${clock.toFixed(1)}s, seek_to calls: ${seeks}, failed calls: ${ends.filter((e) => !e.ok).length}`);
    const ok = !events.some((e) => e.type === 'error') && seeks > 0 && clock > 60;
    console.log(ok ? '  ok' : '  FAILED: playback was not moved');
    return { ok, events };
  };

  // With nothing open: the agent opens the session, and the conversation for it starts once the data is there.
  const first = await ask('opened', request);
  failed = !first.ok;

  // A session the viewer opened themself, asked about before its data is there: the message goes without the
  // table list, the query waits, and the list comes with a tool result.
  const quali = await page.evaluate(async (listed) => {
    const { host } = await import('/src/host/index.ts');
    await window.omfv.ai.reset();
    if (!listed) return null;
    const sessions = await host.catalog.sessions(listed.args);
    const hit = sessions.find((s) => s.type === 'qualifying' && s.status === 'replay');
    if (!hit) return null;
    await host.session.open({ contentId: hit.contentId, title: hit.title });
    return hit.title;
  }, first.events.find((e) => e.type === 'tool_start' && e.name === 'list_sessions') ?? null);
  if (quali) failed = !(await ask('typed', 'jump to the start of Q2')).ok || failed;
  else console.log('\nNo qualifying replay to open, so the second request was skipped.');
} finally {
  await stop();
}
process.exit(failed ? 1 : 0);
