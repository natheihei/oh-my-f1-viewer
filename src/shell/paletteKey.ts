/**
 * The shortcut that shows and hides the palette: Ctrl+Shift+P, or Cmd+Shift+P, which macOS users reach for. Both
 * work everywhere, and what's written on screen names the one for this platform.
 */

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Whether `platform` (as `navigator.platform` gives it) is a Mac. */
export function isMacPlatform(platform: string): boolean {
  return /^Mac/.test(platform);
}

/** The shortcut as this platform writes it. */
export function paletteKeyLabel(mac: boolean): string {
  return mac ? '⌘⇧P' : 'Ctrl+Shift+P';
}

export const PALETTE_KEY = paletteKeyLabel(typeof navigator !== 'undefined' && isMacPlatform(navigator.platform));

/** Whether a key press is the palette's shortcut. */
export function isPaletteKey(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p';
}
