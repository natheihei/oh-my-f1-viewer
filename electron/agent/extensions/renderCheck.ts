import { notDrawing, problemKey, renderCheckText, type PlaceHealth } from '../../../shared/health';

/**
 * Before a build turn ends, the build agent is told what on screen isn't drawing, and goes on. It can't
 * always fix it: a component may be waiting on something only the user can do. So it's told at most twice
 * for one message, and only while there's a problem it wasn't told about already. See docs/BUILD_MODE.md.
 */
export interface RenderCheck {
  /** Starts a new turn: a message from the user. */
  start(): void;
  /** The agent was just told of these some other way, such as in a save's result. */
  heard(places: PlaceHealth[]): void;
  /** What to tell the agent now that it has answered, or null to let the turn end. */
  next(): Promise<string | null>;
}

export const MAX_RENDER_CHECKS = 2;

export function renderCheck(health: () => Promise<PlaceHealth[] | null>): RenderCheck {
  let checks = 0;
  /** The problems the agent knows of that are still there. */
  let told = new Set<string>();
  return {
    start() {
      checks = 0;
    },
    heard(places) {
      for (const p of notDrawing(places)) told.add(problemKey(p));
    },
    async next() {
      if (checks >= MAX_RENDER_CHECKS) return null;
      const places = await health().catch(() => null);
      if (!places) return null;
      const problems = notDrawing(places);
      const keys = problems.map(problemKey);
      const news = keys.some((key) => !told.has(key));
      told = new Set(keys);
      if (!news) return null;
      checks += 1;
      return renderCheckText(problems);
    },
  };
}
