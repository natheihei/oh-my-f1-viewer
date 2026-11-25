/**
 * The JSON Schema of `models.json` (shared/customModels.ts), written beside it so an editor completes its fields,
 * describes them and marks what's wrong. A model's own objects (`compat`, `cost`, `thinkingLevelMap` and the
 * like) are pi-ai's schemas for them, as the installed pi-ai exports them, so they say what that pi-ai takes. The
 * rest is described here, and must list the same fields parseCustomModels accepts: a test holds them together.
 */
import { CUSTOM_APIS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, MAX_CUSTOM_MODELS, MAX_CUSTOM_PROVIDERS } from '../../shared/customModels';

type Schema = Record<string, unknown>;

/** pi-ai's compat schema for a model on one of the wired-in APIs, or for any of them when the API isn't known here. */
function compatSchema(byApi: Record<string, Schema>, description: string): Schema {
  return { description, anyOf: CUSTOM_APIS.map((api) => byApi[api]).filter(Boolean) };
}

export async function customModelsSchema(): Promise<Schema> {
  const model = await import('@earendil-works/pi-ai/providers/model-schema');
  const compat = await import('@earendil-works/pi-ai/providers/compat-schema');
  const byApi = compat.CompatSchemasByApi as unknown as Record<string, Schema>;
  const api = (description: string): Schema => ({ description, enum: [...CUSTOM_APIS] });
  const url = (description: string): Schema => ({ type: 'string', pattern: '^https?://', description });
  const headers = (description: string): Schema => ({ type: 'object', additionalProperties: { type: 'string' }, description });
  const modelSchema: Schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1, description: "The model's id on the server, as its requests name it." },
      name: { type: 'string', minLength: 1, description: 'Shown in the panel. Default: the id.' },
      api: api("The API this model speaks. Default: the provider's."),
      baseUrl: url("Where this model's server is. Default: the provider's."),
      reasoning: { type: 'boolean', description: 'Whether the model can think: the panel then offers thinking levels. Default: false.' },
      thinkingLevelMap: { ...(model.ThinkingLevelMapSchema as unknown as Schema), description: "What the server is sent for each thinking level. null marks a level the model doesn't have." },
      input: { type: 'array', items: { enum: ['text', 'image'] }, contains: { const: 'text' }, uniqueItems: true, description: 'What the model can be sent. Default: ["text"].' },
      inputLimits: { ...(model.ModelInputLimitsSchema as unknown as Schema), description: 'Limits on what one request may carry, such as how many images and how large.' },
      cost: { ...(model.ModelCostSchema as unknown as Schema), description: 'What the model costs, in USD per million tokens. Default: nothing, as for a local model.' },
      promptCache: { ...(model.ModelPromptCacheSchema as unknown as Schema), description: "How long the server keeps a prompt's cache, in seconds." },
      contextWindow: { type: 'integer', minimum: 1, description: `The context the model is loaded with, in tokens. Default: ${DEFAULT_CONTEXT_WINDOW}.` },
      maxTokens: { type: 'integer', minimum: 1, description: `The most the model writes in one reply, in tokens. Default: ${DEFAULT_MAX_TOKENS}.` },
      samplingParams: { type: 'object', description: 'Sampling parameters sent with every request, such as top_p. OpenAI-compatible APIs only.' },
      samplingParamsByThinkingLevel: { type: 'object', description: 'Sampling parameters for one thinking level, over samplingParams. Keyed off, minimal, low, medium, high, xhigh, max.' },
      headers: headers("Sent with this model's requests, over the provider's."),
      compat: compatSchema(byApi, "pi-ai's compatibility overrides for this model's API. Default: the provider's."),
    },
  };
  const provider: Schema = {
    type: 'object',
    additionalProperties: false,
    required: ['models'],
    properties: {
      name: { type: 'string', minLength: 1, description: "Shown in the panel. Default: the provider's key." },
      baseUrl: url('Where the server is, like http://localhost:11434/v1. Each model needs one, its own or this.'),
      api: api('The API the models speak. Default: openai-completions, which every local server speaks.'),
      apiKey: { type: 'string', minLength: 1, description: 'The API key, for a server that needs one, in plain text. Leave it out for one that needs none.' },
      headers: headers('Sent with every request.'),
      compat: compatSchema(byApi, "pi-ai's compatibility overrides, for each model that sets none of its own."),
      models: { type: 'array', minItems: 1, maxItems: MAX_CUSTOM_MODELS, items: modelSchema, description: 'The models offered in /settings-agent. Only the id of each is needed.' },
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'oh-my-f1-viewer models.json',
    description: "Models set up by hand for OMFV's agent: providers for pi-ai's createProvider(), each with its models as pi-ai Models.",
    type: 'object',
    additionalProperties: false,
    required: ['providers'],
    properties: {
      $schema: { type: 'string', description: 'Where this schema is, for the editor.' },
      providers: {
        type: 'object',
        description: 'One entry for each server. Its key is the id the app knows it by.',
        maxProperties: MAX_CUSTOM_PROVIDERS,
        propertyNames: { pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
        additionalProperties: provider,
      },
    },
  };
}
