import type { ExtensionFactory } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { notDrawing, problemKey, renderCheckText, type PlaceHealth } from '../../../shared/health';

export interface RenderCheck {
  factory: ExtensionFactory;
  /** Starts a new turn: a message from the user. */
  start(): void;
  /** The agent was just told of these some other way, such as in a save's result. */
  heard(places: PlaceHealth[]): void;
}

/** How many times one message from the user can send the agent back to fix what isn't drawing. */
export const MAX_RENDER_CHECKS = 2;

/**
 * Before the build agent ends a turn, looks at how every tile and draft is drawing. If something isn't,
 * the agent is told and goes on, so a problem is fixed in the turn that caused it and not the next.
 *
 * Some problems the agent can't fix alone, such as a draft that needs a driver nobody named. So it's
 * sent on only when there's a problem it hasn't been told of, here or in a save's result, and at most
 * twice a turn. `health` is null when the app couldn't say.
 */
export function renderCheck(health: () => Promise<PlaceHealth[] | null>): RenderCheck {
  let checks = 0;
  /** The problems the agent knows of that are still there. */
  let told = new Set<string>();
  return {
    factory: (pi) => {
      pi.on('agent_before_settle', async (event) => {
        // A turn that was stopped or failed isn't sent on.
        if (event.outcome !== 'completed' || checks >= MAX_RENDER_CHECKS) return;
        const places = await health().catch(() => null);
        if (!places) return;
        const problems = notDrawing(places);
        const keys = problems.map(problemKey);
        const news = keys.some((key) => !told.has(key));
        // One that's gone and comes back is new again.
        told = new Set(keys);
        if (!news) return;
        checks += 1;
        return {
          entries: [{ type: 'custom_message', customType: 'f1a-render-check', content: renderCheckText(problems), display: false }],
          continue: true,
        };
      });
    },
    start() {
      checks = 0;
    },
    heard(places) {
      for (const p of notDrawing(places)) told.add(problemKey(p));
    },
  };
}
