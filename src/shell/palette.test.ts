import { beforeEach, describe, expect, it } from 'vitest';
import { palette, usePalette, type Fix } from './palette';

const fix = (run: Fix['run'], command = '/login-f1tv'): Fix => ({ detail: 'why', label: 'Sign in', command, busy: 'waiting', run });
const entry = (id: number) => usePalette.getState().entries.find((e) => e.id === id)!;

describe('fix blocks', () => {
  beforeEach(() => usePalette.setState({ entries: [], panel: null }));

  it('becomes the line its fix resolves to once it works', async () => {
    let finish: (line: string) => void = () => {};
    const id = palette.pushFix('F1 TV ended your sign-in.', fix(() => new Promise((resolve) => (finish = resolve))));
    expect(entry(id)).toMatchObject({ role: 'error', fix: { label: 'Sign in' } });

    const running = palette.runFix(id);
    expect(entry(id).fix?.running).toBe(true);
    // A second click while it runs does nothing.
    void palette.runFix(id);
    finish('F1 TV signed in.');
    await running;
    expect(entry(id)).toEqual({ id, role: 'system', text: 'F1 TV signed in.' });
  });

  it('stays, with why under it, when the fix fails, and can be tried again', async () => {
    let tries = 0;
    const id = palette.pushFix('x', fix(async () => {
      tries += 1;
      if (tries === 1) throw new Error("Error invoking remote method 'f1tv:login': Error: window closed");
      return 'done';
    }));
    await palette.runFix(id);
    expect(entry(id).fix).toMatchObject({ running: false, failed: 'window closed' });
    await palette.runFix(id);
    expect(entry(id)).toMatchObject({ role: 'system', text: 'done' });
  });

  it('dismissed, leaves the error with the command that fixes it', () => {
    const id = palette.pushFix('F1 TV ended your sign-in.', fix(async () => 'done'));
    palette.dismissFix(id);
    expect(entry(id)).toEqual({ id, role: 'error', text: 'F1 TV ended your sign-in. /login-f1tv fixes it.' });
  });

  it('only the newest block offering a fix asks for it', () => {
    const first = palette.pushFix('a', fix(async () => 'done'));
    const other = palette.pushFix('b', fix(async () => 'done', '/settings-agent'));
    const second = palette.pushFix('c', fix(async () => 'done'));
    expect(entry(first).fix).toBeUndefined();
    expect(entry(first)).toMatchObject({ role: 'error', text: 'a' });
    expect(entry(other).fix).toBeDefined();
    expect(entry(second).fix).toBeDefined();
  });
});

describe('panels', () => {
  beforeEach(() => usePalette.setState({ entries: [], panel: null }));

  it('tells whoever opened a panel when it closes, once', async () => {
    const closed = palette.panelClosed('agent');
    expect(usePalette.getState().panel).toBe('agent');
    expect(palette.closePanel()).toBe(true);
    await closed;
    expect(palette.closePanel()).toBe(false);
  });

  it('a panel opened over another closes that one for whoever waited on it', async () => {
    let first = false;
    palette.openPanel('agent', () => (first = true));
    palette.openPanel('background');
    expect(first).toBe(true);
    expect(palette.closePanel()).toBe(false);
  });
});
