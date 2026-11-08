/**
 * `/` commands: account actions the user runs themselves. A separate set from the agent's tools
 * (shared/tools.ts): neither can call the other, and anything to do with viewing goes to the agent.
 */
import { palette } from './palette';

export interface SlashCommand {
  name: string;
  description: string;
  run(): Promise<void>;
}

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim();
}

/** Tells the user what still needs signing in, or that they can start. */
export async function reportReadiness(): Promise<void> {
  const [f1, ai] = await Promise.all([
    window.f1a.f1tv.status().catch(() => ({ signedIn: false, ready: false })),
    window.f1a.ai.status().catch(() => ({ signedIn: false, model: null })),
  ]);
  const missing: string[] = [];
  if (!f1.signedIn) missing.push('/login-f1tv');
  if (!ai.signedIn) missing.push('/login-chatgpt');
  if (missing.length) {
    palette.push('system', `Sign in to get started: ${missing.join(', ')}`);
  } else {
    palette.push('system', 'Ready. Name a session, like "2025 Mexico race".');
  }
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/login-f1tv',
    description: 'Sign in to F1 TV',
    async run() {
      palette.push('system', 'Complete F1 TV sign-in in the window that just opened.');
      try {
        await window.f1a.f1tv.login();
        palette.push('system', 'F1 TV signed in.');
        await reportReadiness();
      } catch (e) {
        palette.push('error', `F1 TV sign-in failed: ${errorText(e)}`);
      }
    },
  },
  {
    name: '/login-chatgpt',
    description: 'Sign in with ChatGPT for the agent',
    async run() {
      palette.push('system', 'Complete ChatGPT sign-in in your browser.');
      try {
        await window.f1a.ai.login();
        palette.push('system', 'ChatGPT signed in.');
        await reportReadiness();
      } catch (e) {
        palette.push('error', `ChatGPT sign-in failed: ${errorText(e)}`);
      }
    },
  },
  {
    name: '/logout-f1tv',
    description: 'Sign out of F1 TV',
    async run() {
      await window.f1a.f1tv.logout();
      palette.push('system', 'F1 TV signed out.');
    },
  },
  {
    name: '/logout-chatgpt',
    description: 'Sign out of ChatGPT',
    async run() {
      await window.f1a.ai.logout();
      palette.push('system', 'ChatGPT signed out.');
    },
  },
];

export function matchCommands(input: string): SlashCommand[] {
  const needle = input.trim().toLowerCase();
  if (!needle.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(needle));
}
