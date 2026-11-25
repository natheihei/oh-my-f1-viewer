/**
 * The providers set up in `/settings-agent` → Advanced (shared/customModels.ts), as pi-ai providers: each is one
 * call of pi-ai's `createProvider()` on pi's own APIs, with the setup's models as pi-ai `Model`s, so a local server
 * is reached the way pi reaches any OpenAI- or Anthropic-compatible one.
 */
import type { ApiKeyAuth, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, type CustomApi, type CustomProvider } from '../../shared/customModels';
import type { SupportedProvider } from './supported';

/**
 * What's sent as the key to a server that needs none. pi's OpenAI and Anthropic APIs won't make a request
 * without a key, and local servers ignore it.
 */
export const NO_KEY = 'omfv-no-key';

/** pi-ai's parts a custom provider is made of. */
export interface CustomParts {
  createProvider: (input: Parameters<typeof import('@earendil-works/pi-ai', { with: { 'resolution-mode': 'import' } }).createProvider>[0]) => Provider;
  apis: Record<CustomApi, () => ProviderStreams>;
}

/** The setup's key, or none. No credential is stored for one of these, and no variable of the environment is read. */
export function customAuth(label: string, apiKey: string | undefined): ApiKeyAuth {
  return {
    name: `${label} API key`,
    resolve: async ({ signal }) => {
      signal.throwIfAborted();
      return apiKey ? { auth: { apiKey }, source: 'setup' } : { auth: { apiKey: NO_KEY }, source: 'none' };
    },
  };
}

/**
 * The pi-ai provider for one entry of Advanced. Each model is a pi-ai `Model` as the setup writes it, with the
 * provider's server, API and headers unless it has its own, and a default for what it leaves out.
 */
export function customProvider(parts: CustomParts, id: string, config: CustomProvider): Provider {
  const label = config.name ?? id;
  const shared = config.headers ?? {};
  const models = config.models.map((m): Model<CustomApi> => {
    const compat = m.compat ?? config.compat;
    const headers = { ...shared, ...m.headers };
    return {
      id: m.id,
      name: m.name ?? m.id,
      api: m.api ?? config.api ?? 'openai-completions',
      provider: id,
      // parseCustomModels has checked that each model has one, its own or the provider's.
      baseUrl: (m.baseUrl ?? config.baseUrl) as string,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ['text'],
      cost: (m.cost as Model<CustomApi>['cost'] | undefined) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
      ...(compat ? { compat: compat as Model<CustomApi>['compat'] } : {}),
      ...(m.inputLimits ? { inputLimits: m.inputLimits as Model<CustomApi>['inputLimits'] } : {}),
      ...(m.promptCache ? { promptCache: m.promptCache as Model<CustomApi>['promptCache'] } : {}),
      ...(m.samplingParams ? { samplingParams: m.samplingParams as Model<CustomApi>['samplingParams'] } : {}),
      ...(m.samplingParamsByThinkingLevel ? { samplingParamsByThinkingLevel: m.samplingParamsByThinkingLevel as Model<CustomApi>['samplingParamsByThinkingLevel'] } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  });
  const apis = [...new Set(models.map((m) => m.api))];
  return parts.createProvider({
    id,
    name: label,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(Object.keys(shared).length ? { headers: shared } : {}),
    auth: { apiKey: customAuth(label, config.apiKey) },
    models,
    api: apis.length === 1 ? parts.apis[apis[0]]() : Object.fromEntries(apis.map((api) => [api, parts.apis[api]()])),
  });
}

/**
 * The panel's entry for one, in the same shape as a supported provider's. The server and API shown are the
 * provider's, or its first model's when only the models name them.
 */
export function customEntry(id: string, config: CustomProvider): SupportedProvider {
  const first = config.models[0];
  return {
    provider: id,
    label: config.name ?? id,
    ways: {},
    models: config.models.map((m) => m.id),
    custom: { baseUrl: (config.baseUrl ?? first.baseUrl) as string, api: config.api ?? first.api ?? 'openai-completions', hasKey: !!config.apiKey },
  };
}
