/** The link to outside agents, which the main process serves over MCP. See docs/MCP.md. */
import type { ExternalReply, ExternalRequest } from '../../shared/external';

export const externalLink = {
  onRequest: (cb: (request: ExternalRequest) => void): (() => void) => window.f1a.external.onRequest(cb),
  reply: (reply: ExternalReply): void => window.f1a.external.reply(reply),
  ready: (): void => window.f1a.external.ready(),
};
