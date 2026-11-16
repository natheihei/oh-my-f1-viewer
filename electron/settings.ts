/**
 * The app's settings: one JSON file in the profile, `<userData>/f1a-settings.json`, that main owns. The
 * agent's are under `agent` (shared/agentSettings.ts) and the renderer's small UI state, such as the volume,
 * under `ui`. Every build of the app that runs on a profile shares them, however its page is served. Edit
 * it by hand only while the app is closed: the app writes what it holds over it.
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

  /** Reads `file` now. A missing or unreadable one starts empty, and is replaced at the first change. */
  constructor(private readonly file: string) {
    let values: unknown = {};
    try {
      values = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[settings] ${file} can't be read, so it starts empty:`, (e as Error).message);
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
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const next = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(next, `${JSON.stringify(this.values, null, 2)}\n`);
      fs.renameSync(next, this.file);
    } catch (e) {
      console.warn('[settings] saving:', (e as Error).message);
    }
  }
}

let shared: SettingsFile | null = null;

/** The profile's settings, read at first use. */
export function appSettings(): SettingsFile {
  shared ??= new SettingsFile(path.join(app.getPath('userData'), 'f1a-settings.json'));
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
