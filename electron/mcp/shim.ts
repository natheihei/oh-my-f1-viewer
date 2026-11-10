/**
 * The MCP server an outside agent starts: `bin/f1a-mcp`, which runs this with the app's Electron as Node.
 * It speaks MCP over stdio and forwards tool lists and calls to the running app over its socket. When
 * the app starts or quits, it tells the agent its tools changed. See docs/MCP.md.
 */
import net from 'node:net';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { dataDir, socketPath, type LinkRequest, type LinkResponse } from './protocol';

const RETRY_MS = 2000;
/** The repository: this file runs from dist-electron/electron/mcp. */
const ROOT = path.resolve(__dirname, '..', '..', '..');

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Ask = { method: 'hello' } | { method: 'tools' } | { method: 'call'; name: string; args: Record<string, unknown> };

/** The connection to the app, which comes and goes with it. */
class AppLink {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  onChange: () => void = () => {};

  constructor(private readonly path: string) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  connect(): void {
    const socket = net.createConnection(this.path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.socket = socket;
      this.onChange();
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = JSON.parse(line) as LinkResponse;
        const waiting = this.pending.get(response.id);
        if (!waiting) continue;
        this.pending.delete(response.id);
        if (response.ok) waiting.resolve(response.result);
        else waiting.reject(new Error(response.error));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      const was = this.socket === socket;
      this.socket = null;
      for (const waiting of this.pending.values()) waiting.reject(new Error('f1a quit.'));
      this.pending.clear();
      if (was) this.onChange();
      setTimeout(() => this.connect(), RETRY_MS);
    });
  }

  request<T>(ask: Ask): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(notRunning()));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      socket.write(JSON.stringify({ id, ...ask } as LinkRequest) + '\n');
    });
  }
}

const notRunning = () => `f1a isn't running. Start it (npm start in ${ROOT}), and its tools appear here.`;

function instructions(modsDir: string): string {
  return `f1a is a multi-view Formula 1 viewer, and these tools control it and show it to you.

- Start with state: what's open, the tiles on screen, the components a tile can show, and the session data's tables and roster.
- Finding something to watch: catalog_events and catalog_sessions, then session_open. Tiles: layout_add, with a component name and props.
- Session data: data_sql. It sees only what had happened at the frame on screen, unless asOf is "session", which reveals what comes later, results included. The user may not have watched yet: set it only when they accept that, and don't repeat what it shows unless they asked.
- New views are mods: a tile component in its own folder, ${modsDir}/<name>/main.tsx. The app compiles and reloads it on every save while playback carries on. It exports default defineComponent({ name: '<the folder name>', title, description, args: Type.Object({...}), spec: (props) => ({ key, label }), View }), and can import 'f1a' (the host: useSql, useLive, read, host, defineComponent), 'f1a/kit' (the chart kit: ChartFrame, ChartCanvas, colors, text, scales), 'react', 'typebox' and its own files. Check types with tsc -p ${modsDir}. A complete example: ${path.join(ROOT, 'examples', 'mods', 'lap_form', 'main.tsx')}.
- After saving a mod: mods_check, then layout_add it, then screenshot with its tile key to see it. mods_logs has its console output and render errors.
- More: ${path.join(ROOT, 'docs', 'MODS.md')} and ${path.join(ROOT, 'docs', 'HOST.md')}.`;
}

async function main(): Promise<void> {
  const link = new AppLink(socketPath());
  const server = new Server(
    { name: 'f1a', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: instructions(path.join(dataDir(), 'mods')) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!link.connected) return { tools: [] };
    return { tools: await link.request<Tool[]>({ method: 'tools' }) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await link.request<CallToolResult>({ method: 'call', name: request.params.name, args: request.params.arguments ?? {} });
    } catch (e) {
      return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  });

  let ready = false;
  link.onChange = () => {
    if (ready) void server.sendToolListChanged().catch(() => {});
  };
  link.connect();
  await server.connect(new StdioServerTransport());
  ready = true;
}

void main();
