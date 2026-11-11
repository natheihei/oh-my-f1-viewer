import type { ExtensionFactory } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

/**
 * Sends SYSTEM.md followed by the renderer's reference. Replacing the whole prompt also keeps out what pi
 * would add around it, like the working directory. The reference changes rarely, so it goes at the end of
 * the system prompt, ahead of a history that grows. `base` replaces SYSTEM.md, for a session with its own
 * instructions.
 */
export function promptExtension(reference: () => string, base?: string): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      const prompt = base ?? event.systemPromptOptions.customPrompt ?? '';
      const extra = reference();
      return { systemPrompt: extra ? `${prompt}\n\n${extra}` : prompt };
    });
  };
}
