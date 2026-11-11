/**
 * The providers and models `/settings-agent` offers. Anything else in pi's catalog is left out.
 *
 * To pick from everything pi offers, with each model's thinking levels:
 *   - `node devscripts/agent-catalog.mjs` lists the catalog of the installed pi. That's what the app can use.
 *   - https://pi.dev/models is pi's live catalog. It can be newer than the installed pi: the app never
 *     fetches it, so a model only listed there needs a pi upgrade first.
 *
 * Each model must exist in the installed pi's catalog for its provider. `recommended` is what a new
 * connection starts with. GPT-6 Luna and GPT-6.1 Terra have run the app's tools on a ChatGPT plan, and nothing on an API key yet.
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
  recommended: { model: string; thinking: ThinkingLevel };
}

export const SUPPORTED: SupportedProvider[] = [
  {
    provider: 'openai',
    label: 'OpenAI',
    ways: { oauth: 'uses your ChatGPT plan', api_key: 'billed by OpenAI per token' },
    models: ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra'],
    recommended: { model: 'gpt-6.1-terra', thinking: 'medium' },
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    ways: { api_key: 'billed by Anthropic per token' },
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
    recommended: { model: 'claude-sonnet-5-5', thinking: 'medium' },
  },
];

export function supported(provider: string | undefined | null): SupportedProvider | undefined {
  return SUPPORTED.find((s) => s.provider === provider);
}
