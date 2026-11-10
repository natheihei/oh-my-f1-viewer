/** Answers the main process for outside agents: tool definitions, tool calls and where tiles are. See docs/MCP.md. */
import { host, type ExternalRequest } from '../host';
import { externalTools, tilesOnScreen } from './tools';

async function answer(request: ExternalRequest): Promise<unknown> {
  switch (request.method) {
    case 'tools':
      return externalTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    case 'tiles':
      return tilesOnScreen();
    case 'call': {
      const tool = externalTools().find((t) => t.name === request.name);
      if (!tool) throw new Error(`Unknown tool: ${request.name}`);
      return tool.run(request.args ?? {});
    }
  }
}

export function connectExternal(): () => void {
  const stop = host.external.onRequest((request) => {
    answer(request).then(
      (value) => host.external.reply({ id: request.id, ok: true, value }),
      (e: unknown) => host.external.reply({ id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  });
  host.external.ready();
  return stop;
}
