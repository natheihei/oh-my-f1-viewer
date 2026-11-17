/**
 * The fixes the palette offers under an error, as a block with a button (see `Fix` in palette.ts). Each is the
 * same as a `/` command, which the block names: signing in to F1 TV, loading its events again, and connecting
 * the agent's provider. Once onboarding is over, every sign-in or setup problem comes to the viewer this way.
 */
import type { AgentErrorFix } from '../../shared/api';
import { host } from '../host';
import { palette, type Fix } from './palette';

/** Signs in to F1 TV, then loads its events, which the agent needs to find anything. */
async function signInF1tv(): Promise<void> {
  await host.account.login('f1tv');
  const index = await host.catalog.loadIndex();
  if (index.state !== 'ready') throw new Error(`Signed in, but F1 TV's events didn't load: ${index.error ?? 'unknown error'}.`);
}

/** F1 TV isn't signed in: never was, or F1 TV ended the sign-in. */
export function f1tvFix(why: 'missing' | 'expired', then?: () => Promise<void>): Fix {
  return {
    detail: why === 'expired' ? 'Video and timing stopped. Sign in again, then open the session again.' : 'Every feed and all the timing come from your F1 TV subscription.',
    label: why === 'expired' ? 'Sign in again' : 'Sign in',
    command: '/login-f1tv',
    busy: 'Finish signing in in the window that opened.',
    async run() {
      await signInF1tv();
      void then?.();
      return then ? 'F1 TV signed in. Sending your message again.' : 'F1 TV signed in.';
    },
  };
}

/** F1 TV's events didn't load. */
export function eventsFix(then?: () => Promise<void>): Fix {
  return {
    detail: 'The agent needs them to find a session by name.',
    label: 'Retry',
    command: '/reload-events',
    busy: "Loading F1 TV's events…",
    async run() {
      const index = await host.catalog.loadIndex();
      if (index.state !== 'ready') throw new Error(`They didn't load again: ${index.error ?? 'unknown error'}.`);
      void then?.();
      return "F1 TV's events loaded.";
    },
  };
}

const AGENT_FIX: Record<AgentErrorFix, { detail: string; label: string }> = {
  setup: { detail: 'You tell the agent what to watch. Connect the model it runs on.', label: 'Set up the agent' },
  connect: { detail: 'The sign-in may have expired or been revoked. Connect again.', label: 'Connect again' },
  limit: { detail: 'Pick another model or provider to keep going.', label: 'Change model' },
};

/**
 * The agent can't answer until its provider is connected again, or another is chosen. The fix opens agent
 * settings, and once they close with the agent ready, `resend` sends the message that failed.
 */
export function agentFix(kind: AgentErrorFix, resend?: () => Promise<void>): Fix {
  const { detail, label } = AGENT_FIX[kind];
  return {
    detail: resend ? `${detail} Your message is sent again after.` : detail,
    label,
    command: '/settings-agent',
    busy: 'Waiting for agent settings to close…',
    async run() {
      await palette.panelClosed('agent');
      const status = await host.agent.status();
      if (!status.ready) throw new Error("The agent still isn't connected.");
      if (!resend) return `Agent: ${status.modelName ?? 'connected'}.`;
      void resend();
      return `Agent: ${status.modelName ?? 'connected'}. Sending your message again.`;
    },
  };
}
