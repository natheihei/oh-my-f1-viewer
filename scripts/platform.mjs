// What the checks need that differs by platform: where the main profile is, where the Electron binary is, and how a
// check's app is started. On Hyprland a check's app opens silently on workspace 3 and never takes focus; anywhere else,
// macOS included, it's started as an ordinary process and opens like any window.
import { execFileSync, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/** Electron's `appData` for this platform, as `app.getPath('appData')` gives it. */
function appData() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** The main profile: `~/.config/oh-my-f1-viewer` on Linux, `~/Library/Application Support/oh-my-f1-viewer` on macOS. */
export const MAIN_PROFILE = path.join(appData(), 'oh-my-f1-viewer');

/** The Electron binary `npm install` put in node_modules: the electron package's own export names it. */
export const ELECTRON_BIN = createRequire(import.meta.url)('electron');

/** Whether checks open their app through Hyprland. */
export const ON_HYPRLAND = !!process.env.HYPRLAND_INSTANCE_SIGNATURE;

/** Chromium aborts at startup with the CHROME_DESKTOP value Claude's desktop app sets. */
export function appEnv(extra = {}) {
  const { CHROME_DESKTOP: _ignored, ...env } = process.env;
  return { ...env, ...extra };
}

/**
 * Starts Electron with `args` and `env` added to the environment. On Hyprland it opens on workspace 3, floating,
 * `width` by `height` and without focus. Elsewhere it's a detached process, sized by the app as usual. Either way the
 * app outlives this call: checks stop it by its user data dir. `log`, when given, gets the app's output.
 */
export function startElectron(args, { env = {}, width = 1600, height = 900, log = null } = {}) {
  if (ON_HYPRLAND) {
    const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
    // `exec` keeps electron as the spawned pid that Hyprland's rules match.
    const command = `sh -c 'exec env -u CHROME_DESKTOP ${vars} ${[ELECTRON_BIN, ...args].join(' ')}${log ? ` >>${log} 2>&1` : ''}'`;
    execFileSync('hyprctl', ['eval', `hl.exec_cmd(${JSON.stringify(command)}, { workspace = "3 silent", float = true, size = "${width} ${height}", no_initial_focus = true })`]);
    return null;
  }
  const stdio = log ? ['ignore', openSync(log, 'a'), openSync(log, 'a')] : 'ignore';
  const child = spawn(ELECTRON_BIN, args, { env: appEnv(env), detached: true, stdio });
  child.unref();
  return child;
}
