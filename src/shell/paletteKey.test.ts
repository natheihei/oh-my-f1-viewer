import { describe, expect, it } from 'vitest';
import { isMacPlatform, isPaletteKey, paletteKeyLabel } from './paletteKey';

const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('the palette shortcut', () => {
  it('is Ctrl+Shift+P or Cmd+Shift+P, whatever the case of the key', () => {
    expect(isPaletteKey(press('P', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPaletteKey(press('p', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPaletteKey(press('P', { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('needs Shift, and no Alt', () => {
    expect(isPaletteKey(press('p', { ctrlKey: true }))).toBe(false);
    expect(isPaletteKey(press('P', { shiftKey: true }))).toBe(false);
    expect(isPaletteKey(press('P', { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isPaletteKey(press('O', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('is written the way the platform writes it', () => {
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('Linux x86_64')).toBe(false);
    expect(isMacPlatform('Win32')).toBe(false);
    expect(paletteKeyLabel(true)).toBe('⌘⇧P');
    expect(paletteKeyLabel(false)).toBe('Ctrl+Shift+P');
  });
});
