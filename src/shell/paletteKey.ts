/**
 * The shortcut that shows and hides the palette. Ctrl+K by default, or Cmd+K, which macOS users reach for: Ctrl and
 * Cmd are one modifier here, and either works everywhere. The viewer can change it by clicking the key written at
 * the end of the palette's input row, and it's kept across restarts. What's written on screen names it the way
 * this platform does.
 *
 * A key is matched by where it is on the keyboard (`KeyboardEvent.code`), not by what it types, so Shift or Option
 * changing the character doesn't change the shortcut.
 */
import { create } from 'zustand';
import { loadUiState, saveUiState, type UiStorage } from './uiState';

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** A shortcut: one key, with Ctrl or Cmd (`mod`), Shift and Alt (Option) each held or not. */
export interface PaletteBinding {
  code: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export const DEFAULT_PALETTE_KEY: PaletteBinding = { code: 'KeyK', mod: true, shift: false, alt: false };

const KEY = 'paletteKey';

/** Whether `platform` (as `navigator.platform` gives it) is a Mac. */
export function isMacPlatform(platform: string): boolean {
  return /^Mac/.test(platform);
}

/** Whether this machine is a Mac, which writes its keys its own way. */
export const MAC = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform);

const PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** A key's `code` as a person reads it: `KeyK` is K, `Digit1` is 1, `Slash` is /. */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num${code.slice(6)}`;
  return PUNCTUATION[code] ?? code;
}

/** The `code` for a press that has none, as some synthetic ones don't: worked out from the letter or digit it typed. */
function codeOf(e: KeyLike): string {
  if (e.code) return e.code;
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^[A-Z]$/.test(k)) return `Key${k}`;
  if (/^\d$/.test(k)) return `Digit${k}`;
  return k === ' ' ? 'Space' : k;
}

/** The shortcut as this platform writes it: ⇧⌘K on a Mac, Ctrl+Shift+K elsewhere. */
export function bindingLabel(b: PaletteBinding, mac: boolean = MAC): string {
  const key = keyName(b.code);
  if (mac) return `${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${b.mod ? '⌘' : ''}${key}`;
  return [b.mod ? 'Ctrl' : '', b.alt ? 'Alt' : '', b.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** The press as a shortcut, or null while only modifiers are held. */
export function bindingOf(e: KeyLike): PaletteBinding | null {
  const code = codeOf(e);
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) || /^(Control|Shift|Alt|Meta)$/.test(e.key)) return null;
  return { code, mod: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey };
}

/** Keys the palette's input and its prompts answer to, with any modifier: Ctrl+← moves by a word, and so on. */
const EDITING = new Set(['Enter', 'NumpadEnter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** What Ctrl or Cmd with these letters already does, with no Shift or Alt. */
const TAKEN_WITH_MOD: Record<string, string> = {
  KeyA: 'select all',
  KeyC: 'copy',
  KeyX: 'cut',
  KeyV: 'paste',
  KeyZ: 'undo',
  KeyY: 'redo',
};

/** What Cmd with these letters does on a Mac, through the app menu. */
const TAKEN_ON_MAC: Record<string, string> = {
  KeyQ: 'quit',
  KeyW: 'close the window',
  KeyH: 'hide the app',
  KeyM: 'minimise the window',
};

/**
 * Why a shortcut can't show and hide the palette, or null if it can. It needs Ctrl, Cmd or Alt, since a bare key
 * would fire while typing, unless it's a function key. It can't be a key the palette's input uses, or one the app
 * or the system already does something with.
 */
export function refusal(b: PaletteBinding, mac: boolean = MAC): string | null {
  const label = bindingLabel(b, mac);
  if (EDITING.has(b.code)) return `${keyName(b.code)} is used while typing and choosing.`;
  if (!b.mod && !b.alt && !/^F\d{1,2}$/.test(b.code)) return `${label} would fire while typing. Add ${mac ? '⌘' : 'Ctrl'} or ${mac ? '⌥' : 'Alt'}.`;
  if (b.mod && !b.alt) {
    const does = (b.shift ? (b.code === 'KeyZ' ? 'redo' : undefined) : TAKEN_WITH_MOD[b.code]) ?? (mac && !b.shift ? TAKEN_ON_MAC[b.code] : undefined);
    if (does) return `${label} is ${does}.`;
  }
  if (!mac && b.alt && !b.mod && b.code === 'F4') return `${label} closes the window.`;
  return null;
}

export function parseSavedBinding(value: unknown): PaletteBinding | null {
  if (typeof value !== 'object' || value == null) return null;
  const { code, mod, shift, alt } = value as Record<string, unknown>;
  if (typeof code !== 'string' || !code || typeof mod !== 'boolean' || typeof shift !== 'boolean' || typeof alt !== 'boolean') return null;
  const binding = { code, mod, shift, alt };
  // One edited by hand into a key the app needs is left out, so the palette can always be reached.
  return refusal(binding) ? null : binding;
}

export const usePaletteKey = create<{ binding: PaletteBinding }>(() => ({ binding: DEFAULT_PALETTE_KEY }));

/** Takes the saved shortcut. Call it once, before the first render. */
export function restorePaletteKey(storage?: UiStorage | null): void {
  usePaletteKey.setState({ binding: loadUiState(KEY, parseSavedBinding, DEFAULT_PALETTE_KEY, storage) });
}

/** Sets the shortcut and saves it; null goes back to the default. */
export function setPaletteKey(binding: PaletteBinding | null, storage?: UiStorage | null): void {
  usePaletteKey.setState({ binding: binding ?? DEFAULT_PALETTE_KEY });
  saveUiState(KEY, binding ?? undefined, storage);
}

export function isDefaultBinding(b: PaletteBinding): boolean {
  return sameBinding(b, DEFAULT_PALETTE_KEY);
}

export function sameBinding(a: PaletteBinding, b: PaletteBinding): boolean {
  return a.code === b.code && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}

/** Whether a key press is the palette's shortcut: the one set now, or the one given. */
export function isPaletteKey(e: KeyLike, binding: PaletteBinding = usePaletteKey.getState().binding): boolean {
  const pressed = bindingOf(e);
  return pressed != null && sameBinding(pressed, binding);
}

/** The shortcut set now, as this platform writes it. Follows changes. */
export function usePaletteKeyLabel(): string {
  return bindingLabel(usePaletteKey((s) => s.binding));
}
