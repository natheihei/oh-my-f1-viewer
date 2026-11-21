/**
 * `/` commands: account actions the user runs themselves, `/auto-layout`, and `/build`, which changes
 * who they're talking to. They're a separate set, and the agent's tools (shared/tools.ts) are another: neither can
 * call the other, and anything to do with viewing goes to the agent.
 */
import { FIRST_SEASON, host, read } from '../host';
import { enterBuild } from './buildMode';
import { agentFix, eventsFix, f1tvFix } from './fixes';
import { goHome } from './home';
import { onboarding, useOnboarding } from './onboardingState';
import { palette } from './palette';
import { runTelemetryCommand } from './telemetry';

export interface SlashCommand {
  name: string;
  description: string;
  /** Whether text may follow the name. The command list doesn't say so: it's a shortcut, not the way in. */
  takesText?: boolean;
  /** What running it means that the viewer should know first. Shown in red beside it, after "! spoiler". */
  warning?: string;
  /** It works on an open session, so it isn't offered without one. */
  needsSession?: boolean;
  /** It closes what's open, a session or the countdown to one, so it isn't offered with neither. */
  needsOpen?: boolean;
  /** `text` is what followed the name, for a command that `takesText`. */
  run(text: string): Promise<void>;
}

/** An error's message, without Electron's wrapping around errors from main. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
      // The vendored F1 TV code names a button from its own app, which OMFV doesn't have.
      .replace(/Please sign in again \(e\.g\. "Sign in with browser"\) and retry\./, 'Sign in again with /login-f1tv.')
      .trim()
  );
}

/**
 * Loads F1 TV's events, which the agent needs to find anything, and offers to retry if that fails. Returns
 * whether they're loaded. Needs F1 TV signed in. `then` runs once a retry loads them, such as a message to send.
 * While onboarding shows, its own step says so instead.
 */
export async function loadEvents(then?: () => Promise<void>): Promise<boolean> {
  const index = await host.catalog.loadIndex();
  if (index.state === 'ready') return true;
  if (!useOnboarding.getState().active) palette.pushFix(`Couldn't load F1 TV's events: ${index.error ?? 'unknown error'}.`, eventsFix(then));
  return false;
}

/**
 * Says what still needs doing, each as a fix, or loads the events and says the viewer can start. While
 * onboarding shows, it says all of that itself.
 */
export async function reportReadiness(): Promise<void> {
  if (useOnboarding.getState().active) return;
  const { f1tv: f1, agent } = await host.account.status();
  if (!f1.signedIn) palette.pushFix("F1 TV isn't signed in.", f1tvFix('missing'));
  if (!agent.ready) palette.pushFix("The agent isn't set up yet.", agentFix('setup'));
  if (f1.signedIn && !(await loadEvents())) return;
  if (f1.signedIn && agent.ready) palette.push('system', `Ready. Name a session from ${FIRST_SEASON} on, like "2025 Mexico race".`);
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/build',
    description: 'Enter build mode',
    // "/build a lap stepper" also sends the request, as a shortcut.
    takesText: true,
    // The build agent reads the open session past the playhead without asking: see docs/BUILD_MODE.md.
    warning: 'the agent looks ahead without asking',
    // The build agent checks what it writes against the open session's data and video.
    needsSession: true,
    run: (text) => enterBuild(text),
  },
  {
    name: '/auto-layout',
    description: 'Re-tile the grid, undoing moves and resizes',
    needsSession: true,
    async run() {
      host.layout.autoLayout();
      palette.push('system', 'Grid re-tiled.');
    },
  },
  {
    name: '/close-session',
    description: 'Close the session and go back to the list of sessions',
    needsOpen: true,
    run: () => goHome(),
  },
  {
    name: '/settings-background',
    description: 'Choose the background in the gaps between tiles',
    async run() {
      palette.openPanel('background');
    },
  },
  {
    name: '/settings-agent',
    description: "Choose the agent's provider, model and thinking level",
    async run() {
      palette.openPanel('agent');
    },
  },
  {
    name: '/settings-usage',
    description: 'See or turn off the anonymous usage counts',
    // "/settings-usage off" turns them off.
    takesText: true,
    run: (text) => runTelemetryCommand(text),
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
    name: '/reload-events',
    description: "Load F1 TV's events again",
    async run() {
      if (await loadEvents()) palette.push('system', "F1 TV's events loaded.");
    },
  },
  {
    name: '/reset-onboarding',
    description: 'Show the steps to get started again',
    async run() {
      onboarding.reset();
      if (read().session != null) palette.push('system', 'Onboarding shows once no session is open.');
    },
  },
  {
    name: '/version',
    description: 'Show which release of OMFV this is',
    async run() {
      const [{ release, packaged }, { ready }] = await Promise.all([host.app.version(), host.app.update()]);
      const which = release ? `OMFV ${release}.` : packaged ? 'OMFV, built by hand: not a release.' : 'OMFV from source, not a release.';
      palette.push('system', ready ? `${which} ${ready} installs automatically next time you start oh-my-f1-viewer.` : which);
    },
  },
  {
    name: '/whats-new',
    description: "Open this release's notes in the browser",
    async run() {
      await host.app.whatsNew();
      palette.push('system', 'Opened the release notes in your browser.');
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
];

/** A command line split into its name and what follows it. */
export function parseCommand(input: string): { name: string; rest: string } {
  const text = input.trim();
  const space = text.search(/\s/);
  return space < 0 ? { name: text.toLowerCase(), rest: '' } : { name: text.slice(0, space).toLowerCase(), rest: text.slice(space).trim() };
}

/** The commands that do something now: with no session open, not the ones that work on it. */
export function availableCommands(): SlashCommand[] {
  const { session, countdown } = read();
  return SLASH_COMMANDS.filter((c) => (!c.needsSession || session != null) && (!c.needsOpen || session != null || countdown != null));
}

/** The commands the input could become. Once something follows the name, only one that takes it. */
export function matchCommands(input: string): SlashCommand[] {
  if (!input.trimStart().startsWith('/')) return [];
  const { name, rest } = parseCommand(input);
  const available = availableCommands();
  if (rest || /\s$/.test(input)) return available.filter((c) => c.name === name && c.takesText);
  return available.filter((c) => c.name.startsWith(name));
}
