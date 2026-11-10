/** Command palette state: what's in the history box, and whether it is showing. */
import { create } from 'zustand';

export type EntryRole = 'user' | 'agent' | 'system' | 'error';

export interface PaletteEntry {
  id: number;
  role: EntryRole;
  text: string;
}

/** A settings panel the palette shows in its place. */
export type PalettePanel = 'background';

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
  push(role: EntryRole, text: string): number {
    const id = nextEntry++;
    usePalette.setState((s) => ({ entries: [...s.entries, { id, role, text }] }));
    return id;
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
