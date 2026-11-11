import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/api';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

import { ASK_TIMEOUT_MS, setSpoilerAsker, spoilerGate, type SpoilerRequest } from '../agent/spoilerGate';
import { useSession } from '../data/session';
import { askViewer, lookAhead, useLookAhead } from './lookAhead';
import { usePalette } from './palette';

const race = { contentId: 1, title: 'Race', status: 'replay' } as SessionInfo;
const quali = { contentId: 2, title: 'Qualifying', status: 'replay' } as SessionInfo;
const readAhead: SpoilerRequest = { kind: 'read_ahead', session: 'Race', playheadMs: 1_000, sql: 'SELECT 1' };
const seekForward: SpoilerRequest = { kind: 'seek_forward', session: 'Race', playheadMs: 1_000, targetMs: 2_000 };

const asking = () => useLookAhead.getState().asking;
const lastLine = () => usePalette.getState().entries.at(-1)?.text;

/** Asks the gate, answers once the check shows, and returns the decision. */
async function ask(request: SpoilerRequest, answer?: 'once' | 'session' | 'no') {
  const decision = spoilerGate(request);
  await Promise.resolve();
  if (answer) {
    expect(asking()).toBe(true);
    lookAhead.answer(answer);
  }
  return decision;
}

let offAsker: () => void;
const initialClock = useSession.getState().clock;

beforeEach(() => {
  offAsker = setSpoilerAsker(askViewer);
  useSession.setState({ session: race });
});

afterEach(() => {
  lookAhead.endTurn();
  useLookAhead.setState({ asking: false, sessionAllowed: null });
  useSession.setState({ session: null, clock: initialClock });
  offAsker();
  vi.useRealTimers();
});

describe('spoiler check', () => {
  it('waits for the viewer, and a no refuses', async () => {
    const decision = spoilerGate(readAhead);
    await Promise.resolve();
    expect(asking()).toBe(true);
    expect(usePalette.getState().open).toBe(true);
    lookAhead.answer('no');
    expect(await decision).toEqual({ approved: false });
    expect(asking()).toBe(false);
    expect(lastLine()).toBe("The agent didn't look ahead.");
  });

  it('yes (once) lasts for the rest of the turn, and covers a forward seek too', async () => {
    expect(await ask(readAhead, 'once')).toEqual({ approved: true });
    expect(await ask(readAhead)).toEqual({ approved: true });
    expect(await ask(seekForward)).toEqual({ approved: true });
    expect(asking()).toBe(false);

    lookAhead.endTurn();
    void spoilerGate(seekForward);
    await Promise.resolve();
    expect(asking()).toBe(true);
  });

  it('yes (for the session) lasts across turns, until another session opens', async () => {
    expect(await ask(seekForward, 'session')).toEqual({ approved: true });
    expect(lastLine()).toBe('The agent may look ahead for this session.');
    lookAhead.endTurn();
    expect(await ask(readAhead)).toEqual({ approved: true });

    useSession.setState({ session: quali });
    void spoilerGate(readAhead);
    await Promise.resolve();
    expect(asking()).toBe(true);
  });

  it('a session yes can be taken back', async () => {
    await ask(readAhead, 'session');
    lookAhead.revokeSession();
    void spoilerGate(readAhead);
    await Promise.resolve();
    expect(asking()).toBe(true);
  });

  it('refuses when the viewer does not answer in time, before the tool call times out', async () => {
    vi.useFakeTimers();
    const decision = spoilerGate(readAhead);
    await Promise.resolve();
    expect(asking()).toBe(true);
    vi.advanceTimersByTime(ASK_TIMEOUT_MS);
    expect(await decision).toEqual({ approved: false, reason: "they didn't answer" });
    expect(asking()).toBe(false);
    expect(lastLine()).toBe("No answer, so the agent didn't look ahead.");
    expect(ASK_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('a turn that ends or stops refuses an open check', async () => {
    const decision = spoilerGate(seekForward);
    await Promise.resolve();
    lookAhead.endTurn();
    expect(await decision).toEqual({ approved: false, reason: 'the request ended' });
    expect(asking()).toBe(false);
  });

  it('does not ask to read ahead at the live edge, but does behind it, and for a forward seek', async () => {
    useSession.setState({ clock: { ...initialClock, live: true, atLiveEdge: true } });
    expect(await ask(readAhead)).toEqual({ approved: true });
    expect(asking()).toBe(false);

    void spoilerGate(seekForward);
    await Promise.resolve();
    expect(asking()).toBe(true);
    lookAhead.answer('no');

    useSession.setState({ clock: { ...initialClock, live: true, atLiveEdge: false } });
    void spoilerGate(readAhead);
    await Promise.resolve();
    expect(asking()).toBe(true);
  });

  it('refuses when nothing can ask the viewer', async () => {
    offAsker();
    expect(await spoilerGate(readAhead)).toEqual({ approved: false, reason: 'the app could not ask them' });
  });
});
