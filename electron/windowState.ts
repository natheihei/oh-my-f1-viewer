/**
 * Where the main window opens and how big it is. The first time, it fills most of the display it opens
 * on, at a 16:10 shape at most; after that it opens where the user last left it, as long as that is still
 * on a connected display. The state lives in a small file in the profile, read before the window is
 * created so it opens at the right size straight away. Sizes are the page's area inside the window;
 * positions are the window's own.
 */
import fs from 'node:fs';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState extends Rect {
  maximized: boolean;
}

/** Below this the UI breaks: the `/` menu's rows overlap and the palette stops fitting. */
export const MIN_SIZE = { width: 640, height: 480 } as const;

/** How much of the display's usable area a new window takes, and the widest shape it takes it at. */
const FILL = 0.85;
const MAX_ASPECT = 16 / 10;

/** How much of a saved window must still be on a display for it to be put back there. */
const VISIBLE = { width: 100, height: 50 };

/** A new window on a display with this usable area: centred, most of it, no wider than 16:10. */
export function defaultBounds(workArea: Rect): Rect {
  const height = Math.max(MIN_SIZE.height, Math.round(workArea.height * FILL));
  const width = Math.max(MIN_SIZE.width, Math.round(Math.min(workArea.width * FILL, height * MAX_ASPECT)));
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

/** How close to its display's usable area a maximized window has to be. */
const MAXIMIZED_SLACK = 40;

/**
 * Whether the window is really maximized: Electron says so and it fills the usable area of its display.
 * Some Wayland compositors, Hyprland among them, tell every window it is maximized, floating or not.
 */
export function isFilling(reportedMaximized: boolean, size: { width: number; height: number }, workArea: Rect): boolean {
  return reportedMaximized && size.width >= workArea.width - MAXIMIZED_SLACK && size.height >= workArea.height - MAXIMIZED_SLACK;
}

/** The saved state, or null if it isn't one. */
export function parseWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ints = [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!ints || typeof v.maximized !== 'boolean') return null;
  const [x, y, width, height] = [v.x, v.y, v.width, v.height].map((n) => Math.round(n as number));
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height, maximized: v.maximized };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Where the window opens: the saved state if enough of it is on one of `workAreas`, shrunk to fit that
 * display if it has got smaller; otherwise the default on `fallback`, the display the mouse is on.
 */
export function openingState(saved: WindowState | null, workAreas: Rect[], fallback: Rect): WindowState {
  if (saved) {
    const home = workAreas.find((area) => {
      const o = overlap(saved, area);
      return o.width >= VISIBLE.width && o.height >= VISIBLE.height;
    });
    if (home) {
      return {
        ...saved,
        width: Math.max(MIN_SIZE.width, Math.min(saved.width, home.width)),
        height: Math.max(MIN_SIZE.height, Math.min(saved.height, home.height)),
      };
    }
  }
  return { ...defaultBounds(fallback), maximized: false };
}

/** The state saved in `file`, or null if there's none or it can't be read. */
export function loadWindowState(file: string): WindowState | null {
  try {
    return parseWindowState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Saves `state` to `file`. Failing to save only means the window opens at the default size next time. */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    fs.writeFileSync(file, JSON.stringify(state) + '\n');
  } catch (e) {
    console.warn('[window] could not save the window size:', (e as Error).message);
  }
}
