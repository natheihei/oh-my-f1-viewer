import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_HIDE_MS, palette, usePalette, type Fix } from './palette';

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

describe('hiding once the viewer moves away', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePalette.setState({ open: true, busy: false, entries: [], unread: false });
  });
  afterEach(() => {
    palette.attend();
    palette.setBusy(false);
    vi.useRealTimers();
  });

  it('hides once the time is up', () => {
    palette.leave();
    vi.advanceTimersByTime(AWAY_HIDE_MS - 1);
    expect(usePalette.getState().open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(usePalette.getState().open).toBe(false);
  });

  it('stays when the viewer comes back before the time is up', () => {
    palette.leave();
    palette.attend();
    vi.advanceTimersByTime(AWAY_HIDE_MS);
    expect(usePalette.getState().open).toBe(true);
  });

  it('stays when what it waited on says no once the time is up', () => {
    let held = false;
    palette.leave(() => !held);
    held = true;
    vi.advanceTimersByTime(AWAY_HIDE_MS);
    expect(usePalette.getState().open).toBe(true);
  });

  it('hides while the agent is working, and the agent starting a turn keeps the time', () => {
    palette.leave();
    palette.setBusy(true);
    vi.advanceTimersByTime(AWAY_HIDE_MS);
    expect(usePalette.getState().open).toBe(false);
  });

  it('never hides itself while the viewer is in it, however the agent ends', () => {
    palette.attend();
    palette.setBusy(true);
    palette.append(palette.push('agent', ''), 'Done.');
    palette.setBusy(false);
    vi.advanceTimersByTime(60_000);
    expect(usePalette.getState().open).toBe(true);
  });
});

describe('unread', () => {
  beforeEach(() => usePalette.setState({ open: true, busy: false, entries: [], unread: false }));
  afterEach(() => palette.attend());

  it('is nothing the viewer was in the palette for', () => {
    palette.attend();
    palette.push('agent', 'Here.');
    palette.pushFix('x', fix(async () => 'done'));
    palette.ask();
    expect(usePalette.getState().unread).toBe(false);
  });

  it('is a reply streamed while the viewer is away, even one they were there to start', () => {
    palette.attend();
    const id = palette.push('agent', '');
    expect(usePalette.getState().unread).toBe(false);
    palette.leave();
    palette.append(id, 'More.');
    expect(usePalette.getState().unread).toBe(true);
  });

  it('is an error, a fix or a question that comes while the palette is hidden', () => {
    for (const come of [() => palette.push('error', 'Broke.'), () => palette.pushFix('x', fix(async () => 'done')), palette.ask]) {
      palette.attend();
      palette.hide();
      come();
      expect(usePalette.getState().unread).toBe(true);
    }
  });

  it('a question shows the palette with the viewer in it, and waits folded from elsewhere', () => {
    palette.attend();
    usePalette.setState({ open: false });
    palette.ask();
    expect(usePalette.getState()).toMatchObject({ open: true, unread: false });
    palette.hide();
    palette.ask();
    expect(usePalette.getState()).toMatchObject({ open: false, unread: true });
  });

  it("isn't the viewer's own lines, the app's notes, or an empty line", () => {
    palette.hide();
    palette.push('user', 'hi');
    palette.push('system', 'Loading the timing.');
    palette.push('agent', '');
    expect(usePalette.getState().unread).toBe(false);
  });

  it('is read once the viewer comes back, by focus, a click or its key', () => {
    palette.hide();
    palette.push('agent', 'Here.');
    palette.summon();
    expect(usePalette.getState()).toMatchObject({ unread: false, open: true });
    expect(palette.isAway()).toBe(false);
  });
});
