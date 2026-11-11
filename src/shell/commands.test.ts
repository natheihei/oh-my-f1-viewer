import { describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { matchCommands, parseCommand, SLASH_COMMANDS } = await import('./commands');

const names = (input: string) => matchCommands(input).map((c) => c.name);

describe('/ commands', () => {
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

  it('keeps matching a command that takes text once the text starts, and no other', () => {
    expect(names('/build ')).toEqual(['/build']);
    expect(names('/build a controller')).toEqual(['/build']);
    expect(names('/login-f1tv now')).toEqual([]);
    expect(names('/b a controller')).toEqual([]);
  });

  it('warns that build mode reads the whole session', () => {
    const build = SLASH_COMMANDS.find((c) => c.name === '/build');
    expect(build?.description).toBe('Enter build mode');
    expect(build?.warning).toBe('spoiler alert - agent may read beyond where you are');
    expect(SLASH_COMMANDS.filter((c) => c.warning).map((c) => c.name)).toEqual(['/build']);
  });
});
