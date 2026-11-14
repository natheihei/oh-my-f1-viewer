import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { agent, useAgentTurn } = await import('./agentTurn');

/** Each send waits here until the test ends its turn. */
let turns: (() => void)[];
beforeEach(() => {
  turns = [];
  vi.stubGlobal('window', { f1a: { ai: { send: () => new Promise<void>((resolve) => turns.push(resolve)) } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAgentTurn.setState({ busy: false });
});

const send = () => agent.send('hi', 'state', [], '');
const busy = () => useAgentTurn.getState().busy;

describe('whether the agent is busy', () => {
  it('is, from when a message is sent until its turn ends', async () => {
    expect(busy()).toBe(false);
    const sent = send();
    expect(busy()).toBe(true);
    turns[0]();
    await sent;
    expect(busy()).toBe(false);
  });

  it('stays so when a newer message takes over from one still running', async () => {
    const first = send();
    const second = send();
    // The first turn was stopped for the second: its send comes back, and the agent is still working.
    turns[0]();
    await first;
    expect(busy()).toBe(true);
    turns[1]();
    await second;
    expect(busy()).toBe(false);
  });

  it('is not, once a send fails', async () => {
    vi.stubGlobal('window', { f1a: { ai: { send: () => Promise.reject(new Error('no agent')) } } });
    await expect(send()).rejects.toThrow('no agent');
    expect(busy()).toBe(false);
  });
});
