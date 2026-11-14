/** Command palette state: what's in the history box, and whether it is showing. */
import { create } from 'zustand';
import type { PromptPart } from './mentions';

export type EntryRole = 'user' | 'agent' | 'system' | 'error';

export interface PaletteEntry {
  id: number;
  role: EntryRole;
  text: string;
  /** A prompt with mentions in it, drawn with their tags. `text` is the same as the agent read it. */
  parts?: PromptPart[];
  /** Something the viewer can do about this line, once: a button after its text. */
  action?: { label: string; run(): void };
  /** Tiles whose errors went with this line, drawn as tags before its text, as they stood when sent. */
  attached?: AttachedTag[];
}

/** A tile as an attachment's tag names it: its id, and its title-bar label. */
export interface AttachedTag {
  scope: string;
  label: string;
}

/** A settings panel the palette shows in its place. */
export type PalettePanel = 'background' | 'agent';

interface PaletteState {
  open: boolean;
  busy: boolean;
  entries: PaletteEntry[];
  panel: PalettePanel | null;
}

export const usePalette = create<PaletteState>(() => ({ open: true, busy: false, entries: [], panel: null }));

let nextEntry = 1;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function cancelHide(): void {
  if (hideTimer != null) clearTimeout(hideTimer);
  hideTimer = null;
}

export const palette = {
  push(role: EntryRole, text: string, action?: PaletteEntry['action'], parts?: PromptPart[], attached?: AttachedTag[]): number {
    const id = nextEntry++;
    const extra = { ...(action ? { action } : {}), ...(parts ? { parts } : {}), ...(attached?.length ? { attached } : {}) };
    usePalette.setState((s) => ({ entries: [...s.entries, { id, role, text, ...extra }] }));
    return id;
  },
  /** Runs an entry's action, which then goes: it can only be taken once. */
  act(id: number): void {
    const entry = usePalette.getState().entries.find((e) => e.id === id);
    if (!entry?.action) return;
    usePalette.setState((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, action: undefined } : e)) }));
    entry.action.run();
  },
  /** Appends to an entry being streamed. */
  append(id: number, delta: string): void {
    usePalette.setState((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, text: e.text + delta } : e)),
    }));
  },
  setBusy(busy: boolean): void {
    usePalette.setState({ busy });
    if (busy) cancelHide();
  },
  show(): void {
    cancelHide();
    usePalette.setState({ open: true });
  },
  hide(): void {
    cancelHide();
    usePalette.setState({ open: false });
  },
  hideAfter(ms: number): void {
    cancelHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      usePalette.setState({ open: false });
    }, ms);
  },
  /** Typing or focusing the palette keeps it open. */
  keepOpen: cancelHide,
  /** Shows a settings panel where the palette is, until it's closed. */
  openPanel(panel: PalettePanel): void {
    cancelHide();
    usePalette.setState({ open: true, panel });
  },
  closePanel(): void {
    usePalette.setState({ panel: null });
  },
};
