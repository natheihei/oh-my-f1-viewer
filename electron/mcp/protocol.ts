/**
 * What `bin/f1a-mcp` and the app say to each other over the socket: one JSON object per line. Kept free
 * of Electron, so the stdio server can load it as plain Node. See docs/MCP.md.
 */
import os from 'node:os';
import path from 'node:path';

export type LinkRequest =
  | { id: number; method: 'hello' }
  | { id: number; method: 'tools' }
  | { id: number; method: 'call'; name: string; args: Record<string, unknown> };

export type LinkResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** A tool call's result, as MCP has it. */
export interface CallResult {
  content: Content[];
  isError?: boolean;
}

export interface Hello {
  modsDir: string;
}

/** The app's data folder, as Electron names it for an app called f1a. */
export function dataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'f1a');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'f1a');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'f1a');
}

/** Where the app listens. A unix socket that only the user can open, or a named pipe on Windows. */
export function socketPath(dir = dataDir()): string {
  if (process.env.F1A_SOCKET) return process.env.F1A_SOCKET;
  return process.platform === 'win32' ? '\\\\.\\pipe\\f1a-mcp' : path.join(dir, 'f1a.sock');
}
