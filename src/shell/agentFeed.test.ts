import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { defineComponent, host, read } = await import('../host');
const { health, useHealth } = await import('../host/health');
const { useBuild } = await import('../host/build');
const { layout } = await import('../layout/store');
const { useEventIndex } = await import('../data/catalog');
const { sendToAgent } = await import('./agentFeed');
const { stayInView, switchToBuild } = await import('./buildMode');
const { palette, usePalette } = await import('./palette');

const gap = defineComponent({
  name: 'gap_ahead',
  title: 'Gap ahead',
  description: 'A test component.',
  args: Type.Object({ drivers: Type.Array(Type.Number()) }),
  spec: ({ drivers }) => ({ key: `gap_ahead:${drivers.join(':')}`, label: 'Gap ahead' }),
  View: () => null,
});
const threw = {
  where: 'tile' as const,
  type: 'gap_ahead',
  label: 'Gap ahead',
  state: 'error' as const,
  missing: [],
  dropped: [],
  message: "Cannot read properties of undefined (reading 'interval')",
};

/** What the agent was sent, after its app_state. */
const sent = () => send.mock.calls.map(([text]) => text);
let send: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let ids: string[] = [];

beforeEach(() => {
  host.components.register({ components: [gap] });
  ids = host.layout.add({ items: [{ type: 'gap_ahead', props: { drivers: [4] } }, { type: 'gap_ahead', props: { drivers: [44] } }] });
  for (const scope of ids) health.report({ scope, ...threw }, null);
  // Build mode skips the event list, which needs F1 TV.
  useBuild.setState({ active: true, changes: [], enteredAtSec: 0, offer: null });
  vi.spyOn(host.agent, 'status').mockResolvedValue({ ready: true } as never);
  send = vi.fn(async (_text: string) => {});
  vi.spyOn(host.agent, 'send').mockImplementation(send);
  vi.spyOn(host.build, 'begin').mockImplementation((async () => useBuild.setState({ active: true, offer: null })) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const p of useHealth.getState().places) health.forget(p.scope);
  useHealth.setState({ attached: [] });
  useBuild.setState({ active: false, changes: [], enteredAtSec: null, offer: null });
  layout.clear();
  host.components.unregister({ names: ['gap_ahead'] });
  usePalette.setState({ entries: [] });
});

describe("the viewer's message", () => {
  it('takes what was attached, as error blocks before their words, and draws the tiles as tags', async () => {
    host.health.attach({ scope: ids[0] });
    host.health.attach({ scope: ids[1] });
    await sendToAgent('broke when NOR pitted');
    const [text] = sent();
    expect(text.match(/<error>/g)).toHaveLength(2);
    expect(text.indexOf(`"tile": "${ids[0]}"`)).toBeLessThan(text.indexOf(`"tile": "${ids[1]}"`));
    expect(text.endsWith('</error>\n\nbroke when NOR pitted')).toBe(true);
    expect(read().attached).toEqual([]);
    expect(usePalette.getState().entries.at(-1)).toMatchObject({ role: 'user', text: 'broke when NOR pitted', attached: ids.map((scope) => ({ scope, label: 'Gap ahead' })) });
  });

  it('can be the attachments alone', async () => {
    host.health.attach({ scope: ids[0] });
    await sendToAgent('');
    expect(sent()[0]).toMatch(/^<error>\n[\s\S]*\n<\/error>$/);
  });

  it('leaves the tray for the next message when this one can\'t go', async () => {
    vi.spyOn(host.agent, 'status').mockResolvedValue({ ready: false } as never);
    host.health.attach({ scope: ids[0] });
    await sendToAgent('fix it');
    expect(send).not.toHaveBeenCalled();
    expect(read().attached.map((a) => a.scope)).toEqual([ids[0]]);
  });

  it('withdraws an offer of build mode', async () => {
    useBuild.setState({ offer: { reason: 'fix the gap chart', note: '', tiles: [ids[0]] } });
    await sendToAgent('never mind');
    expect(read().build.offer).toBeNull();
  });
});

describe('taking up an offer of build mode', () => {
  beforeEach(() => useBuild.setState({ active: false }));

  it("starts the build agent at once on the tiles' errors and the viewing agent's note, leaving the tray", async () => {
    host.health.attach({ scope: ids[1] });
    await switchToBuild({ reason: 'fix the gap chart', note: 'It throws in the pit lane.', tiles: [ids[0]] });
    expect(read().build.active).toBe(true);
    const [text] = sent();
    expect(text).toContain(`"tile": "${ids[0]}"`);
    expect(text).not.toContain(`"tile": "${ids[1]}"`);
    expect(text.endsWith('</error>\n\n<from_viewing_agent>\nIt throws in the pit lane.\n</from_viewing_agent>')).toBe(true);
    expect(read().attached.map((a) => a.scope)).toEqual([ids[1]]);
    expect(usePalette.getState().entries.at(-1)).toMatchObject({ role: 'system', text: 'went to the build agent.', attached: [{ scope: ids[0], label: 'Gap ahead' }] });
  });

  it('still sends a tile that draws again by then, saying it has no error now', async () => {
    health.report({ scope: ids[0], ...threw, state: 'drawn', message: null }, null);
    await switchToBuild({ reason: 'fix the gap chart', note: 'It threw.', tiles: [ids[0]] });
    expect(read().build.active).toBe(true);
    const [text] = sent();
    expect(text).toContain(`"tile": "${ids[0]}"`);
    expect(text).toContain('"state": "drawn"');
    expect(text).toContain('It has no error now.');
    expect(text).not.toContain('first_threw');
    expect(text.endsWith('<from_viewing_agent>\nIt threw.\n</from_viewing_agent>')).toBe(true);
  });

  it('starts the build agent on the note alone when no tiles are offered', async () => {
    await switchToBuild({ reason: 'Build a tyre wear chart for HAM.', note: 'The user wants to track tyre wear for HAM. No chart does.', tiles: [] });
    expect(read().build.active).toBe(true);
    expect(sent()).toEqual(['<from_viewing_agent>\nThe user wants to track tyre wear for HAM. No chart does.\n</from_viewing_agent>']);
    expect(usePalette.getState().entries.at(-1)).toMatchObject({ role: 'system', text: 'Asked the build agent to build a tyre wear chart for HAM.' });
  });

  it('stays in view mode when turned down', () => {
    useBuild.setState({ offer: { reason: 'fix the gap chart', note: '', tiles: [ids[0]] } });
    stayInView();
    expect(read().build.offer).toBeNull();
    expect(read().build.active).toBe(false);
    expect(usePalette.getState().entries.at(-1)).toMatchObject({ role: 'system', text: 'Stayed in view mode.' });
    palette.hide();
  });

  it('tells the viewing agent what was turned down, once', async () => {
    useBuild.setState({ offer: { reason: 'Build a DRS chart for NOR.', note: '', tiles: [] } });
    stayInView();
    useBuild.setState({ active: false });
    const events = useEventIndex.getState();
    useEventIndex.setState({ state: 'ready' } as never);
    await sendToAgent('ok', { echo: false, attach: false });
    await sendToAgent('and now', { echo: false, attach: false });
    const states = send.mock.calls.map((call: unknown[]) => String(call[1]));
    expect(states[0]).toContain('build mode: the user turned down your offer to build a DRS chart for NOR, and stayed in view mode.');
    expect(states[1]).not.toContain('turned down');
    useEventIndex.setState(events);
  });
});
