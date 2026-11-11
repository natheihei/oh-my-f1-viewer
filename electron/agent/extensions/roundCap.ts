import type { ExtensionFactory } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

export interface RoundCap {
  factory: ExtensionFactory;
  /** Starts counting a new turn. */
  start(): void;
  /** Whether the cap stopped this turn, which pi otherwise can't tell apart from a cancel. */
  readonly capped: boolean;
}

/** Stops a model that keeps calling tools. A round is one model request plus the tools it asked for. */
export function roundCap(max: number): RoundCap {
  let rounds = 0;
  let capped = false;
  return {
    factory: (pi) => {
      pi.on('turn_start', (_event, ctx) => {
        rounds += 1;
        if (rounds > max) {
          capped = true;
          ctx.abort();
        }
      });
    },
    start() {
      rounds = 0;
      capped = false;
    },
    get capped() {
      return capped;
    },
  };
}
