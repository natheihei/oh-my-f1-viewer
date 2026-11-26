/**
 * Optional recommendations for `/settings-agent`. Every built-in provider and chat model comes straight
 * from the installed `@earendil-works/pi-ai` (`builtinProviders()`), with no extra provider or model
 * allowlist. Only providers the app has tried carry a `recommended` default here.
 *
 * To inspect what the installed pi offers, with each model's thinking levels:
 *   - `node devscripts/agent-catalog.mjs` lists the catalog of the installed pi. That's what the app can use.
 *   - https://pi.dev/models is pi's live catalog. It can be newer than the installed pi: the app never
 *     fetches it, so newer models arrive with a pi upgrade.
 */
import type { ConnectWay, ThinkingLevel } from '../../shared/api';

export interface SupportedProvider {
  /** pi's provider id. */
  provider: string;
  label: string;
  /** The ways to connect it, each with a note shown next to its button. */
  ways: Partial<Record<ConnectWay, string>>;
  /** Offered in this order. */
  models: string[];
  /** Optional: set only for providers the app has tried. A new connection starts on it when present. */
  recommended?: { model: string; thinking: ThinkingLevel };
  /**
   * Set for a provider from `/settings-agent` → Advanced (custom.ts), never for a built-in provider. It needs no
   * connecting: its key, if it has one, is in its setup.
   */
  custom?: { baseUrl: string; api: string; hasKey: boolean };
}

/**
 * Default model and thinking level for built-in providers the app has tried. Anything absent here is still
 * offered in full; connecting it simply leaves the viewer to pick a model.
 */
export const RECOMMENDED: Record<string, { model: string; thinking: ThinkingLevel }> = {
  openai: { model: 'gpt-6.1-terra', thinking: 'medium' },
};
