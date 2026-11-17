/**
 * The app's settings: one JSON file in the profile, `<userData>/omfv-settings.json`, that main owns. The
 * agent's are under `agent` (shared/agentSettings.ts) and the renderer's small UI state, such as the volume,
 * under `ui`. Every build of the app that runs on a profile shares them, however its page is served. Edit
 * it by hand only while the app is closed: the app writes what it holds over it. One it can't parse is moved
 * aside to `omfv-settings.json.bad` at the first change, not written over.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** How long a change waits for others before the file is written, so dragging a slider writes once. */
const WRITE_DELAY_MS = 200;

export interface Settings {
  get(key: string): unknown;
  /** Undefined removes it. */
  set(key: string, value: unknown): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class SettingsFile implements Settings {
  private values: Record<string, unknown>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The file is there but couldn't be used, so the first write moves it aside rather than over it. */
  private unusable = false;

  /**
   * Reads `file` now. A missing one starts empty. One that's there but can't be read or isn't a JSON object, such
   * as a hand edit with a typo, also starts empty, and is kept: the first change moves it aside to `<file>.bad`.
   */
  constructor(private readonly file: string) {
    let values: unknown = {};
    try {
      values = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObject(values)) throw new Error('it holds no JSON object');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') values = {};
      else {
        this.unusable = true;
        console.warn(`[settings] ${file} can't be read, so it starts empty, and is moved aside at the first change:`, (e as Error).message);
      }
    }
    this.values = isObject(values) ? values : {};
  }

  get(key: string): unknown {
    return this.values[key];
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    this.timer ??= setTimeout(() => this.flush(), WRITE_DELAY_MS);
  }

  /** Writes what's waiting now, as on quit. Whole or not at all: a crash mid-write leaves the last file. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.unusable && !this.moveAside()) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const next = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(next, `${JSON.stringify(this.values, null, 2)}\n`);
      fs.renameSync(next, this.file);
    } catch (e) {
      console.warn('[settings] saving:', (e as Error).message);
    }
  }

  /**
   * Renames the unusable file to the first free `<file>.bad`, `<file>.bad.1`, …, so an earlier one isn't lost
   * either. False if it couldn't, and then nothing is written over it.
   */
  private moveAside(): boolean {
    try {
      let to = `${this.file}.bad`;
      for (let n = 1; fs.existsSync(to); n++) to = `${this.file}.bad.${n}`;
      fs.renameSync(this.file, to);
      console.warn(`[settings] ${this.file} couldn't be read, so it was moved to ${to}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[settings] ${this.file} couldn't be read or moved aside, so it's left as it is and not saved:`, (e as Error).message);
        return false;
      }
    }
    this.unusable = false;
    return true;
  }
}

let shared: SettingsFile | null = null;

/** The profile's settings, read at first use. */
export function appSettings(): SettingsFile {
  shared ??= new SettingsFile(path.join(app.getPath('userData'), 'omfv-settings.json'));
  return shared;
}

/** The renderer's UI state, by key. */
export function uiState(settings: Settings = appSettings()): Record<string, unknown> {
  const ui = settings.get('ui');
  return isObject(ui) ? ui : {};
}

/** Keeps one piece of the renderer's UI state; undefined removes it. */
export function setUiState(key: string, value: unknown, settings: Settings = appSettings()): void {
  const { [key]: _old, ...rest } = uiState(settings);
  settings.set('ui', value === undefined ? rest : { ...rest, [key]: value });
}
