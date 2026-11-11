import type { ExtensionFactory } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

/**
 * Sends SYSTEM.md followed by the renderer's reference. Replacing the whole prompt also keeps out what pi
 * would add around it, like the working directory. The reference changes rarely, so it goes at the end of
 * the system prompt, ahead of a history that grows.
 */
export function promptExtension(reference: () => string): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      const base = event.systemPromptOptions.customPrompt ?? '';
      const extra = reference();
      return { systemPrompt: extra ? `${base}\n\n${extra}` : base };
    });
  };
}
