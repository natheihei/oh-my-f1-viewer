/**
 * What an outside agent gets over MCP, in the renderer: every host op as a tool, generated from its own
 * description and argument schema, plus `state`. The main process adds the tools it runs itself:
 * screenshots and mods. See docs/MCP.md.
 *
 * There's no spoiler gate: an agent the user brings is theirs to direct. Reads default to what the feed
 * had revealed at the playhead, and the one flag that reads past it says so in the tool's description.
 */
import Value from 'typebox/value';
import { host, read, tileQueries, tilesOf, type ExternalToolDefinition, type GroupNode, type Op, type TileInfo } from '../host';

export interface ExternalTool extends ExternalToolDefinition {
  run(args: Record<string, unknown>): Promise<string>;
}

/**
 * The host groups an outside agent can use. Left out: `components` (its argument is code), `suggestions`
 * (the strip belongs to the app's own agent and the user's pointer), and the sign-ins.
 */
const GROUPS = ['session', 'catalog', 'playback', 'audio', 'layout', 'data'] as const;

/** What an outside agent needs to know that the host's own description leaves out. */
const NOTES: Record<string, string> = {
  data_sql:
    ' Table and column names are in state().sessionData.tables. SPOILERS: asOf "session" reveals what had not happened yet at the playhead, results included.' +
    " Set it only when the user has accepted that, and don't repeat what it returns unless they asked.",
  layout_add: ' items[].type is a component name from state().components, and props must fit its args. A video tile is { type: "video", props: { feed } }, with a feed id from state().feeds.',
  layout_remove: ' Keys are in state().tiles.',
  layout_close: ' Tile ids are in state().tiles.',
  layout_move: ' The grid is 24 by 24 cells. tile is a tile key or group id from state().tiles.',
  session_open: ' contentId comes from catalog_sessions, catalog_live or catalog_upcoming.',
};

const MAX_ROWS = 500;

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Keeps a result small enough to hand a model. */
function shrink(tool: string, out: unknown): unknown {
  if (tool !== 'data_sql' || !out || typeof out !== 'object') return out;
  const { columns, rows } = out as { columns: string[]; rows: unknown[] };
  if (rows.length <= MAX_ROWS) return out;
  return { columns, rows: rows.slice(0, MAX_ROWS), truncated: `${rows.length} rows, only the first ${MAX_ROWS} shown: narrow the query.` };
}

function fromOp(group: string, name: string, op: Op<unknown, unknown>): ExternalTool {
  const tool = `${group}_${snake(name)}`;
  return {
    name: tool,
    description: op.info.description + (NOTES[tool] ?? ''),
    inputSchema: JSON.parse(JSON.stringify(op.info.args)),
    async run(args) {
      // The host trusts its types, and nothing checks an outside call's types but this.
      if (!Value.Check(op.info.args, args)) {
        const error = Value.Errors(op.info.args, args)[0];
        throw new Error(`Invalid arguments: ${error ? `${error.instancePath || '/'} ${error.message}` : "they don't match the schema"}`);
      }
      return JSON.stringify(shrink(tool, await op(args)) ?? null);
    },
  };
}

/** What's open and on screen, in one read. */
export function describeState(): Record<string, unknown> {
  const s = read();
  const data = s.sessionData;
  return {
    session: s.session,
    countdown: s.countdown,
    clock: s.clock,
    feeds: s.feeds,
    audio: s.audio,
    volume: s.volume,
    tiles: tilesOf(s.layout).map((t) => ({
      id: t.id,
      key: t.component.key,
      type: t.component.type,
      label: t.component.label,
      props: t.component.props,
      grid: { x: t.x, y: t.y, w: t.w, h: t.h },
    })),
    groups: s.layout.nodes.filter((n): n is GroupNode => n.kind === 'group').map((g) => ({ id: g.id, title: g.title, tiles: g.children.map((c) => c.component.key) })),
    streams: s.streams,
    sessionData:
      data.state === 'ready'
        ? {
            state: data.state,
            sessionKey: data.sessionKey,
            datasets: data.datasets,
            playheadMs: data.playheadMs,
            lapCount: data.lapCount,
            drivers: data.drivers.map((d) => ({ number: d.driver_number, code: d.name_acronym, name: d.full_name, team: d.team_name })),
            tables: data.tables,
          }
        : data,
    circuit: s.circuit.state === 'ready' ? { state: 'ready', name: s.circuit.name, circuitKey: s.circuit.circuitKey } : { state: s.circuit.state },
    components: s.components,
    mods: s.mods,
    spec: s.spec,
    events: { state: s.events.state, error: s.events.error },
  };
}

const stateTool: ExternalTool = {
  name: 'state',
  description:
    "What's open and on screen: the session, the clock, feeds, tiles (with each tile's key, type and props), audio, the session data's " +
    'state, roster, tables and playhead (UTC ms, as in date columns), the components a tile can show with their props schemas, and the mods. ' +
    'Nothing in it is past the playhead.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => JSON.stringify(describeState()),
};

function buildTools(): ExternalTool[] {
  const tools: ExternalTool[] = [stateTool];
  for (const group of GROUPS) {
    for (const [name, op] of Object.entries(host[group] as Record<string, Op<unknown, unknown>>)) {
      if (typeof op === 'function' && op.info) tools.push(fromOp(group, name, op));
    }
  }
  return tools;
}

let tools: ExternalTool[] | null = null;
export const externalTools = (): ExternalTool[] => (tools ??= buildTools());

/** Every tile's component area on screen, and what its queries last returned. */
export function tilesOnScreen(): TileInfo[] {
  return tilesOf(read().layout).flatMap((t) => {
    const element = document.querySelector(`[data-tile-key="${CSS.escape(t.component.key)}"]`);
    if (!element) return [];
    const r = element.getBoundingClientRect();
    return [
      {
        key: t.component.key,
        type: t.component.type,
        label: t.component.label,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        queries: tileQueries(t.component.key),
      },
    ];
  });
}
