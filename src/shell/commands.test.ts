import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/api';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { matchCommands, parseCommand, SLASH_COMMANDS } = await import('./commands');
const { layout } = await import('../layout/store');
const { useSession } = await import('../data/session');
const { useCountdown } = await import('../host/viewing');
const { useBuild } = await import('../host/build');
const { usePalette } = await import('./palette');
const { useLookAhead } = await import('./lookAhead');

const names = (input: string) => matchCommands(input).map((c) => c.name);
const openSession = () => useSession.setState({ session: { contentId: 1, title: 'x', type: 'race', status: 'replay' } as SessionInfo, channels: [] });

describe('/ commands', () => {
  beforeEach(openSession);
  afterEach(() => useSession.setState({ session: null, channels: [] }));

  it('splits a line into the command and what follows it', () => {
    expect(parseCommand('/build a lap stepper')).toEqual({ name: '/build', rest: 'a lap stepper' });
    expect(parseCommand('  /Build   two  words ')).toEqual({ name: '/build', rest: 'two  words' });
    expect(parseCommand('/login-f1tv')).toEqual({ name: '/login-f1tv', rest: '' });
  });

  it('matches by the start of the name', () => {
    expect(names('/b')).toEqual(['/build']);
    expect(names('/login')).toEqual(['/login-f1tv']);
    expect(names('hello')).toEqual([]);
    expect(names('/')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('leaves out the ones that work on a session until one is open', () => {
    useSession.setState({ session: null, channels: [] });
    expect(names('/b')).toEqual([]);
    expect(names('/a')).toEqual(['/about']);
    expect(names('/build a controller')).toEqual([]);
    expect(names('/')).toEqual(SLASH_COMMANDS.filter((c) => !c.needsSession && !c.needsOpen).map((c) => c.name));
    expect(SLASH_COMMANDS.filter((c) => c.needsSession).map((c) => c.name)).toEqual(['/build', '/auto-layout']);
    openSession();
    expect(names('/b')).toEqual(['/build']);
  });

  it('keeps matching a command that takes text once the text starts, and no other', () => {
    expect(names('/build ')).toEqual(['/build']);
    expect(names('/build a controller')).toEqual(['/build']);
    expect(names('/login-f1tv now')).toEqual([]);
    expect(names('/b a controller')).toEqual([]);
  });

  it('warns that build mode reads the whole session', () => {
    const build = SLASH_COMMANDS.find((c) => c.name === '/build');
    expect(build?.description).toBe('Enter build mode');
    expect(build?.warning).toBe('the agent looks ahead without asking');
    expect(SLASH_COMMANDS.filter((c) => c.warning).map((c) => c.name)).toEqual(['/build']);
  });

  it('re-tiles a grid the mouse has changed', async () => {
    layout.clear();
    layout.add({ key: 'A', label: 'A', type: 'test', props: {} });
    layout.add({ key: 'B', label: 'B', type: 'test', props: {} });
    const [a, b] = layout.snapshot().tiles;
    layout.swap(a.id, b.id);
    expect(layout.snapshot().manual).toBe(true);
    await SLASH_COMMANDS.find((c) => c.name === '/auto-layout')!.run('');
    const after = layout.snapshot();
    expect(after.manual).toBe(false);
    expect(after.tiles[0]).toMatchObject({ x: a.x, y: a.y, w: a.w, h: a.h });
    layout.clear();
  });
});

describe('/close-session', () => {
  const close = () => SLASH_COMMANDS.find((c) => c.name === '/close-session')!;
  const lastLine = () => usePalette.getState().entries.at(-1)?.text;
  const countdown = { title: 'Las Vegas Race', startMs: Date.now() + 3_600_000, session: { contentId: 2, title: 'Las Vegas Race' } as SessionInfo };
  afterEach(() => {
    useSession.setState({ session: null, channels: [] });
    useCountdown.setState({ countdown: null });
    useBuild.setState({ active: false });
    layout.clear();
  });

  it('is offered while a session or a countdown is open, and not with neither', () => {
    expect(names('/close')).toEqual([]);
    openSession();
    expect(names('/close')).toEqual(['/close-session']);
    useSession.setState({ session: null, channels: [] });
    useCountdown.setState({ countdown });
    expect(names('/close')).toEqual(['/close-session']);
  });

  it('closes the session, clearing the grid', async () => {
    openSession();
    layout.add({ key: 'A', label: 'A', type: 'test', props: {} });
    await close().run('');
    expect(useSession.getState().session).toBeNull();
    expect(layout.snapshot().tiles).toEqual([]);
    expect(lastLine()).toBe('Closed x.');
  });

  it('stops a countdown', async () => {
    useCountdown.setState({ countdown });
    await close().run('');
    expect(useCountdown.getState().countdown).toBeNull();
    expect(lastLine()).toBe('Stopped the countdown to Las Vegas Race.');
  });

  it('leaves build mode to its own way out', async () => {
    openSession();
    useBuild.setState({ active: true });
    await close().run('');
    expect(useSession.getState().session).not.toBeNull();
    expect(lastLine()).toBe('Leave build mode first: Save or Undo all.');
  });
});

describe('looking ahead for this session', () => {
  it('ends with the session', async () => {
    const { lookAhead } = await import('./lookAhead');
    useLookAhead.setState({ sessionAllowed: 1 });
    lookAhead.sessionChanged();
    expect(useLookAhead.getState().sessionAllowed).toBeNull();
  });
});

describe('usage counts', () => {
  it('may count every command by its name', async () => {
    const { COMMANDS } = await import('../../shared/telemetry');
    expect([...COMMANDS].sort()).toEqual(SLASH_COMMANDS.map((c) => c.name).sort());
  });
});
