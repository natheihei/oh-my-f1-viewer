import { beforeEach, describe, expect, it, vi } from 'vitest';

// The host, which keeps the saved state, pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));
import type { UiStorage } from './uiState';
import {
  bindingLabel,
  bindingOf,
  DEFAULT_PALETTE_KEY,
  isMacPlatform,
  isPaletteKey,
  parseSavedBinding,
  refusal,
  restorePaletteKey,
  setPaletteKey,
  usePaletteKey,
  type PaletteBinding,
} from './paletteKey';

const press = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

const bind = (code: string, mods: Partial<Omit<PaletteBinding, 'code'>> = {}): PaletteBinding => ({ code, mod: false, shift: false, alt: false, ...mods });

function memory(): UiStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, get: (k) => values.get(k), set: (k, v) => (v === undefined ? values.delete(k) : values.set(k, v)) };
}

beforeEach(() => usePaletteKey.setState({ binding: DEFAULT_PALETTE_KEY }));

describe('the palette shortcut', () => {
  it('is Ctrl+K or Cmd+K by default, whatever the case of the key', () => {
    expect(isPaletteKey(press('k', 'KeyK', { ctrlKey: true }))).toBe(true);
    expect(isPaletteKey(press('K', 'KeyK', { metaKey: true }))).toBe(true);
    // A synthetic press with no code still counts by the letter it typed.
    expect(isPaletteKey({ ...press('k', '', { ctrlKey: true }) })).toBe(true);
  });

  it('needs exactly its modifiers', () => {
    expect(isPaletteKey(press('k', 'KeyK'))).toBe(false);
    expect(isPaletteKey(press('K', 'KeyK', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteKey(press('k', 'KeyK', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteKey(press('P', 'KeyP', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('follows the key where it is, not what Option makes it type', () => {
    usePaletteKey.setState({ binding: bind('KeyP', { alt: true }) });
    expect(isPaletteKey(press('π', 'KeyP', { altKey: true }))).toBe(true);
  });

  it('is written the way the platform writes it', () => {
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('Linux x86_64')).toBe(false);
    expect(bindingLabel(DEFAULT_PALETTE_KEY, true)).toBe('⌘K');
    expect(bindingLabel(DEFAULT_PALETTE_KEY, false)).toBe('Ctrl+K');
    expect(bindingLabel(bind('KeyP', { mod: true, shift: true }), true)).toBe('⇧⌘P');
    expect(bindingLabel(bind('KeyP', { mod: true, shift: true, alt: true }), false)).toBe('Ctrl+Alt+Shift+P');
    expect(bindingLabel(bind('Slash', { mod: true }), false)).toBe('Ctrl+/');
    expect(bindingLabel(bind('Space', { mod: true }), true)).toBe('⌘Space');
  });
});

describe('recording a new shortcut', () => {
  it('waits while only modifiers are held', () => {
    expect(bindingOf(press('Control', 'ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(bindingOf(press('Shift', 'ShiftRight', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(bindingOf(press('j', 'KeyJ', { metaKey: true }))).toEqual(bind('KeyJ', { mod: true }));
  });

  it('keeps one that does nothing else', () => {
    for (const b of [bind('KeyK', { mod: true }), bind('KeyP', { mod: true, shift: true }), bind('Space', { mod: true }), bind('KeyJ', { alt: true }), bind('F2')]) {
      expect(refusal(b, false), bindingLabel(b, false)).toBeNull();
    }
  });

  it('refuses a bare key, which would fire while typing', () => {
    expect(refusal(bind('KeyK'), false)).toBe('K would fire while typing. Add Ctrl or Alt.');
    expect(refusal(bind('KeyK', { shift: true }), true)).toBe('⇧K would fire while typing. Add ⌘ or ⌥.');
  });

  it('refuses keys the input and prompts answer to, with any modifier', () => {
    for (const code of ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowLeft', 'ArrowUp']) {
      expect(refusal(bind(code, { mod: true }), false)).toMatch(/used while typing/);
    }
  });

  it('refuses what the app or the system already does', () => {
    expect(refusal(bind('KeyC', { mod: true }), false)).toBe('Ctrl+C is copy.');
    expect(refusal(bind('KeyV', { mod: true }), true)).toBe('⌘V is paste.');
    expect(refusal(bind('KeyZ', { mod: true, shift: true }), false)).toBe('Ctrl+Shift+Z is redo.');
    expect(refusal(bind('KeyQ', { mod: true }), true)).toBe('⌘Q is quit.');
    expect(refusal(bind('KeyQ', { mod: true }), false)).toBeNull();
    expect(refusal(bind('F4', { alt: true }), false)).toBe('Alt+F4 closes the window.');
    // With Shift or Alt too, the letter is free again.
    expect(refusal(bind('KeyC', { mod: true, shift: true }), false)).toBeNull();
  });
});

describe('keeping the shortcut', () => {
  it('starts at the default with nothing saved, or something unusable', () => {
    const storage = memory();
    restorePaletteKey(storage);
    expect(usePaletteKey.getState().binding).toEqual(DEFAULT_PALETTE_KEY);
    storage.values.set('paletteKey', { code: 'KeyC', mod: true, shift: false, alt: false });
    restorePaletteKey(storage);
    expect(usePaletteKey.getState().binding).toEqual(DEFAULT_PALETTE_KEY);
    expect(parseSavedBinding('Ctrl+K')).toBeNull();
    expect(parseSavedBinding({ code: 'KeyK', mod: 'yes', shift: false, alt: false })).toBeNull();
  });

  it('saves a new one and restores it, and null goes back to the default', () => {
    const storage = memory();
    const next = bind('KeyJ', { mod: true, shift: true });
    setPaletteKey(next, storage);
    expect(usePaletteKey.getState().binding).toEqual(next);
    usePaletteKey.setState({ binding: DEFAULT_PALETTE_KEY });
    restorePaletteKey(storage);
    expect(usePaletteKey.getState().binding).toEqual(next);
    expect(isPaletteKey(press('J', 'KeyJ', { ctrlKey: true, shiftKey: true }))).toBe(true);
    setPaletteKey(null, storage);
    expect(storage.values.has('paletteKey')).toBe(false);
    expect(usePaletteKey.getState().binding).toEqual(DEFAULT_PALETTE_KEY);
  });
});
