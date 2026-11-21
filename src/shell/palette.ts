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
  /** What fixes an error line: drawn as a block with its button, in place of the plain line. */
  fix?: Fix;
}

/**
 * How to fix what an error line reports. The block says what happens after the fix, has the fix as its button
 * and the command that does the same beside it. While it runs the block waits in place; once it's done the
 * block becomes one line in the history.
 */
export interface Fix {
  /** What fixing it does, under the error. */
  detail: string;
  /** The button. */
  label: string;
  /** The `/` command that does the same, so the viewer learns it. */
  command: string;
  /** Said while it runs. */
  busy: string;
  /** Does the fix. Resolves to the line that replaces the block; throws to keep the block, with why under it. */
  run(): Promise<string>;
  /** Running now. */
  running?: boolean;
  /** Why the last try didn't fix it. */
  failed?: string;
}

/** A tile as an attachment's tag names it: its id, and its title-bar label. */
export interface AttachedTag {
  scope: string;
  label: string;
}

/** A settings panel the palette shows in its place. */
export type PalettePanel = 'background' | 'agent';

/** Called once when the panel open now closes, however it closes. */
let onPanelClose: (() => void) | null = null;

interface PaletteState {
  open: boolean;
  busy: boolean;
  entries: PaletteEntry[];
  panel: PalettePanel | null;
}

export const usePalette = create<PaletteState>(() => ({ open: true, busy: false, entries: [], panel: null }));

/** Text for the input from outside the palette, such as a row picked on the landing page. `seq` counts each one. */
export const usePaletteDraft = create<{ text: string; seq: number }>(() => ({ text: '', seq: 0 }));

/** How long the palette stays once it's done with, or once focus leaves it: long enough to read the last line. */
export const AUTO_HIDE_MS = 10_000;

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
  /**
   * An error line with its fix. An earlier block offering the same fix goes back to a plain error line, so
   * only the newest one asks.
   */
  pushFix(text: string, fix: Fix): number {
    const id = nextEntry++;
    usePalette.setState((s) => ({
      entries: [...s.entries.map((e) => (e.fix && !e.fix.running && e.fix.command === fix.command ? { ...e, fix: undefined } : e)), { id, role: 'error', text, fix }],
    }));
    return id;
  },
  /** Runs an entry's fix. Done, the block becomes the line it resolved to; failed, it stays with why. */
  async runFix(id: number): Promise<void> {
    const fix = usePalette.getState().entries.find((e) => e.id === id)?.fix;
    if (!fix || fix.running) return;
    const set = (change: (e: PaletteEntry) => PaletteEntry) => usePalette.setState((s) => ({ entries: s.entries.map((e) => (e.id === id ? change(e) : e)) }));
    set((e) => ({ ...e, fix: { ...fix, running: true, failed: undefined } }));
    try {
      const done = await fix.run();
      set((e) => ({ id: e.id, role: 'system', text: done }));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const failed = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim();
      set((e) => ({ ...e, fix: { ...fix, running: false, failed } }));
    }
  },
  /** Puts an error's fix away: the block becomes a line naming the command, for later. */
  dismissFix(id: number): void {
    usePalette.setState((s) => ({
      entries: s.entries.map((e) => (e.id === id && e.fix && !e.fix.running ? { id: e.id, role: 'error', text: `${e.text} ${e.fix.command} fixes it.` } : e)),
    }));
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
  /** Puts text in the input in place of what's there, and the caret after it. Nothing is sent. */
  draft(text: string): void {
    usePaletteDraft.setState((s) => ({ text, seq: s.seq + 1 }));
  },
  show(): void {
    cancelHide();
    usePalette.setState({ open: true });
  },
  hide(): void {
    cancelHide();
    usePalette.setState({ open: false });
  },
  /**
   * Hides the palette in `ms`, unless something keeps it open first: typing, a click or focus in it, the
   * agent starting a turn. `still` is asked when the time is up, and keeps it open by answering false.
   */
  hideAfter(ms: number, still: () => boolean = () => true): void {
    cancelHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!usePalette.getState().busy && still()) usePalette.setState({ open: false });
    }, ms);
  },
  /** Typing or focusing the palette keeps it open. */
  keepOpen: cancelHide,
  /** Shows a settings panel where the palette is, until it's closed. `onClose` is called when it closes. */
  openPanel(panel: PalettePanel, onClose?: () => void): void {
    cancelHide();
    const before = onPanelClose;
    onPanelClose = onClose ?? null;
    usePalette.setState({ open: true, panel });
    // A panel opened over another closes that one.
    before?.();
  },
  /** Closes the panel. Returns whether whoever opened it was waiting on that, and has been told. */
  closePanel(): boolean {
    usePalette.setState({ panel: null });
    const after = onPanelClose;
    onPanelClose = null;
    after?.();
    return after != null;
  },
  /** Shows a panel, and resolves when it closes. */
  panelClosed(panel: PalettePanel): Promise<void> {
    return new Promise((resolve) => palette.openPanel(panel, resolve));
  },
};
