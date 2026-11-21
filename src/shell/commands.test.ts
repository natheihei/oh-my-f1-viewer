import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/api';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { matchCommands, parseCommand, SLASH_COMMANDS, splitCommands } = await import('./commands');
const { layout } = await import('../layout/store');
const { useSession } = await import('../data/session');

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
    expect(names('/a')).toEqual([]);
    expect(names('/build a controller')).toEqual([]);
    expect(names('/')).toEqual(SLASH_COMMANDS.filter((c) => !c.needsSession).map((c) => c.name));
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

describe('commands named in a line', () => {
  /** The line as the palette draws it, with each command it picked out in brackets, and what it runs with. */
  const marked = (text: string) =>
    splitCommands(text)
      .map((p) => (typeof p === 'string' ? p : `[${p.text}]`))
      .join('');
  const runs = (text: string) => splitCommands(text).flatMap((p) => (typeof p === 'string' ? [] : [[p.command.name, p.rest]]));

  it('picks out each command a line names', () => {
    expect(marked('Onboarding skipped. /reset-onboarding brings it back.')).toBe('Onboarding skipped. [/reset-onboarding] brings it back.');
    expect(marked('Sign in again with /login-f1tv.')).toBe('Sign in again with [/login-f1tv].');
    expect(marked('Updated to OMFV 0.9.0. /whats-new lists what changed.')).toBe('Updated to OMFV 0.9.0. [/whats-new] lists what changed.');
    expect(runs('Onboarding skipped. /reset-onboarding brings it back.')).toEqual([['/reset-onboarding', '']]);
  });

  it('takes the word after a command only when it takes that word', () => {
    const line = 'Use /settings-usage on, /settings-usage off, or /settings-usage alone to see how it stands.';
    expect(marked(line)).toBe('Use [/settings-usage on], [/settings-usage off], or [/settings-usage] alone to see how it stands.');
    expect(runs(line)).toEqual([
      ['/settings-usage', 'on'],
      ['/settings-usage', 'off'],
      ['/settings-usage', ''],
    ]);
    expect(marked('/settings-usage off turns them off.')).toBe('[/settings-usage off] turns them off.');
  });

  it("leaves a name that's part of something longer", () => {
    expect(marked('see docs/build and /buildings or /build-x, a/version')).toBe('see docs/build and /buildings or /build-x, a/version');
    expect(marked('/version/whats-new')).toBe('/version/whats-new');
    expect(marked('no commands here')).toBe('no commands here');
  });

  it('picks out commands added later', () => {
    // Every command in the set is picked out by its name alone.
    for (const c of SLASH_COMMANDS) expect(runs(`try ${c.name}.`)).toEqual([[c.name, '']]);
  });
});

describe('usage counts', () => {
  it('may count every command by its name', async () => {
    const { COMMANDS } = await import('../../shared/telemetry');
    expect([...COMMANDS].sort()).toEqual(SLASH_COMMANDS.map((c) => c.name).sort());
  });
});
