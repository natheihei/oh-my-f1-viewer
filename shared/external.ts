/** Outside agents, connected over MCP: what crosses between the main process and the renderer. See docs/MCP.md. */

export interface ExternalToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
}

/** What the main process asks the renderer. */
export type ExternalRequest =
  | { id: string; method: 'tools' }
  | { id: string; method: 'call'; name: string; args: Record<string, unknown> }
  | { id: string; method: 'tiles' };

export interface ExternalReply {
  id: string;
  ok: boolean;
  /** `tools`: ExternalToolDefinition[]. `call`: the result as text. `tiles`: TileInfo[]. */
  value?: unknown;
  error?: string;
}

/** The last result of one of a tile's queries. */
export interface QueryInfo {
  sql: string;
  state: 'loading' | 'failed' | 'ready';
  reason?: string;
  rowCount?: number;
  /** The first few rows. */
  sample?: Array<Record<string, unknown>>;
}

/** A tile on screen, for screenshots. */
export interface TileInfo {
  key: string;
  type: string;
  label: string;
  /** Where its component draws, in CSS pixels from the window's top left. */
  rect: { x: number; y: number; width: number; height: number };
  queries: QueryInfo[];
}
