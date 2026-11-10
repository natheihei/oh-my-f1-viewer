/**
 * The door for outside agents. `bin/f1a-mcp` speaks MCP over stdio and forwards each request here over a
 * unix socket that only the user can open. Most tools are host ops that run in the renderer: this asks
 * it, the same way the app's own agent's tool calls go. Screenshots and mods are answered here. See
 * docs/MCP.md.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import net from 'node:net';
import type { ExternalReply, ExternalToolDefinition, TileInfo } from '../../shared/external';
import type { Mods } from '../mods';
import { getMainWindow, sendToRenderer } from '../windows';
import type { CallResult, Hello, LinkRequest, LinkResponse } from './protocol';

/** Long enough for a session to open, which waits for its feeds. */
const RENDERER_TIMEOUT_MS = 120_000;
const MOD_SETTLE_MS = 20_000;
/** How long a call waits for the window to load before giving up. */
const READY_WAIT_MS = 30_000;
const LOG_LINES_WITH_SHOT = 10;

const text = (value: unknown): CallResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

interface MainTool extends ExternalToolDefinition {
  run(args: Record<string, unknown>): Promise<CallResult>;
}

export class ExternalServer {
  private server: net.Server | null = null;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly tools: MainTool[];
  /** The renderer is listening: it says so once it has loaded. */
  private ready = false;
  private readyWaiters: Array<() => void> = [];

  constructor(
    private readonly path: string,
    private readonly mods: Mods,
  ) {
    this.tools = this.mainTools();
  }

  start(): void {
    if (process.platform !== 'win32') rmSync(this.path, { force: true });
    const server = net.createServer((socket) => this.serve(socket));
    server.on('error', (e) => console.warn('[mcp] socket:', e.message));
    server.listen(this.path, () => {
      if (process.platform !== 'win32') chmodSync(this.path, 0o600);
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (process.platform !== 'win32') rmSync(this.path, { force: true });
  }

  /** The renderer has loaded and answers requests. */
  rendererReady(): void {
    this.ready = true;
    for (const resolve of this.readyWaiters.splice(0)) resolve();
  }

  /** The renderer is reloading: requests wait until it's back. */
  rendererGone(): void {
    this.ready = false;
  }

  private whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("f1a's window hasn't finished loading.")), READY_WAIT_MS);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The renderer's answer to `ask`. */
  onReply(reply: ExternalReply): void {
    const waiting = this.pending.get(reply.id);
    if (!waiting) return;
    this.pending.delete(reply.id);
    clearTimeout(waiting.timer);
    if (reply.ok) waiting.resolve(reply.value);
    else waiting.reject(new Error(reply.error ?? 'Failed'));
  }

  private serve(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let request: LinkRequest;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        this.handle(request).then(
          (result) => this.send(socket, { id: request.id, ok: true, result }),
          (e: unknown) => this.send(socket, { id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      }
    });
    socket.on('error', () => {});
  }

  private send(socket: net.Socket, response: LinkResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
  }

  private async handle(request: LinkRequest): Promise<unknown> {
    switch (request.method) {
      case 'hello':
        return { modsDir: this.mods.dir } satisfies Hello;
      case 'tools': {
        const fromHost = await this.ask<ExternalToolDefinition[]>({ method: 'tools' });
        return [...fromHost, ...this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))];
      }
      case 'call': {
        const args = request.args ?? {};
        const own = this.tools.find((t) => t.name === request.name);
        try {
          if (own) return await own.run(args);
          return text(await this.ask<string>({ method: 'call', name: request.name, args }));
        } catch (e) {
          return { ...text(e instanceof Error ? e.message : String(e)), isError: true } satisfies CallResult;
        }
      }
    }
  }

  /** Asks the renderer, which runs host ops and knows where tiles are. */
  private async ask<T>(request: { method: 'tools' } | { method: 'tiles' } | { method: 'call'; name: string; args: Record<string, unknown> }): Promise<T> {
    await this.whenReady();
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error("f1a's window isn't open.");
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The app did not answer in time.'));
      }, RENDERER_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sendToRenderer('mcp:request', { id, ...request });
    });
  }

  private mainTools(): MainTool[] {
    const mods = this.mods;
    const withLogs = (name: string, lines: number) => mods.logs(name).slice(-lines);
    return [
      {
        name: 'screenshot',
        description:
          'A PNG of the whole window, or with tile (a key from state().tiles) only that tile. It comes with each tile in the image: its key, type, ' +
          "label and rectangle in CSS pixels, what each of its queries last returned (row count and the first rows), and a mod's latest log lines. " +
          'It shows only what the viewer sees.',
        inputSchema: {
          type: 'object',
          properties: { tile: { type: 'string', description: 'A tile key. Omit for the whole window.' } },
          additionalProperties: false,
        },
        run: async (args) => {
          const win = getMainWindow();
          if (!win || win.isDestroyed()) throw new Error("f1a's window isn't open.");
          const tiles = await this.ask<TileInfo[]>({ method: 'tiles' });
          const key = typeof args.tile === 'string' ? args.tile : null;
          const shown = key === null ? tiles : tiles.filter((t) => t.key === key);
          if (key !== null && !shown.length) {
            throw new Error(`No tile with key "${key}" is on screen. On screen: ${tiles.map((t) => t.key).join(', ') || 'nothing'}.`);
          }
          const r = key === null ? undefined : shown[0].rect;
          const image = await win.webContents.capturePage(
            r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) },
          );
          if (image.isEmpty()) throw new Error("The window isn't being drawn, so there's nothing to capture. Is it minimized?");
          const details = shown.map((t) => {
            const mod = mods.status(t.type);
            return mod ? { ...t, mod: { state: mod.state, version: mod.version, log: withLogs(t.type, LOG_LINES_WITH_SHOT) } } : t;
          });
          return {
            content: [
              { type: 'image', data: image.toPNG().toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: JSON.stringify({ size: image.getSize(), tiles: details }) },
            ],
          };
        },
      },
      {
        name: 'mods_list',
        description: `Every mod in ${mods.dir}: its state (loading, ready or failed), version and error. A failed save keeps the last good version running.`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => text({ dir: mods.dir, mods: mods.list() }),
      },
      {
        name: 'mods_logs',
        description: "A mod's recent console output and render errors, oldest first.",
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: 300, description: 'How many, 50 by default.' } },
          required: ['name'],
          additionalProperties: false,
        },
        run: async (args) => {
          const name = String(args.name);
          if (!mods.status(name)) throw new Error(`No mod named "${name}" in ${mods.dir}.`);
          return text(withLogs(name, Number(args.lines) || 50));
        },
      },
      {
        name: 'mods_check',
        description:
          "Waits for a mod's latest save to build and load, then says whether it did: ready means the app is running that version, failed comes " +
          'with the compiler or loading error. Call it after saving, before putting the mod on screen or taking a screenshot.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
        run: async (args) => {
          const name = String(args.name);
          const status = await mods.settle(name, MOD_SETTLE_MS);
          if (!status) throw new Error(`No mod named "${name}" in ${mods.dir}. A mod is a folder there with a main.tsx.`);
          return { ...text({ ...status, log: withLogs(name, LOG_LINES_WITH_SHOT) }), isError: status.state !== 'ready' };
        },
      },
    ];
  }
}
