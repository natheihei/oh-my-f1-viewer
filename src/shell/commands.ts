/**
 * `/` commands: account actions the user runs themselves. A separate set from the agent's tools
 * (shared/tools.ts): neither can call the other, and anything to do with viewing goes to the agent.
 */
import { FIRST_SEASON, host } from '../host';
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

/**
 * Loads F1 TV's events, which the agent needs to find anything, and says so if that fails. Returns
 * whether they're loaded. Needs F1 TV signed in.
 */
export async function loadEvents(): Promise<boolean> {
  const index = await host.catalog.loadIndex();
  if (index.state === 'ready') return true;
  palette.push('error', `Couldn't load F1 TV's events: ${index.error ?? 'unknown error'}. Retry with /reload-events.`);
  return false;
}

/** Tells the user what still needs signing in, or loads the events and says they can start. */
export async function reportReadiness(): Promise<void> {
  const { f1tv: f1, chatgpt: ai } = await host.account.status();
  const missing: string[] = [];
  if (!f1.signedIn) missing.push('/login-f1tv');
  if (!ai.signedIn) missing.push('/login-chatgpt');
  if (f1.signedIn && !(await loadEvents())) return;
  if (missing.length) {
    palette.push('system', `Sign in to get started: ${missing.join(', ')}`);
  } else {
    palette.push('system', `Ready. Name a session from ${FIRST_SEASON} on, like "2025 Mexico race".`);
  }
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/settings-background',
    description: 'Choose the background in the gaps between tiles',
    async run() {
      palette.openPanel('background');
    },
  },
  {
    name: '/login-f1tv',
    description: 'Sign in to F1 TV',
    async run() {
      palette.push('system', 'Complete F1 TV sign-in in the window that just opened.');
      try {
        await host.account.login('f1tv');
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
        await host.account.login('chatgpt');
        palette.push('system', 'ChatGPT signed in.');
        await reportReadiness();
      } catch (e) {
        palette.push('error', `ChatGPT sign-in failed: ${errorText(e)}`);
      }
    },
  },
  {
    name: '/reload-events',
    description: "Load F1 TV's events again",
    async run() {
      if (await loadEvents()) palette.push('system', "F1 TV's events loaded.");
    },
  },
  {
    name: '/logout-f1tv',
    description: 'Sign out of F1 TV',
    async run() {
      await host.account.logout('f1tv');
      palette.push('system', 'F1 TV signed out.');
    },
  },
  {
    name: '/logout-chatgpt',
    description: 'Sign out of ChatGPT',
    async run() {
      await host.account.logout('chatgpt');
      palette.push('system', 'ChatGPT signed out.');
    },
  },
];

export function matchCommands(input: string): SlashCommand[] {
  const needle = input.trim().toLowerCase();
  if (!needle.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(needle));
}
