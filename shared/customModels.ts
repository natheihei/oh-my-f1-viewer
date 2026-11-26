/**
 * Models set up by hand, for power users: any server pi-ai can talk to, such as a local model on Ollama, LM Studio,
 * llama.cpp or vLLM, or a hosted OpenAI- or Anthropic-compatible endpoint. The setup is a file, `models.json` in
 * the app's user data folder, edited in the viewer's own editor: `/settings-agent` → Advanced opens it and says
 * what's wrong with it, if anything. A new file starts from an example to change (EXAMPLE_CUSTOM_MODELS). The app
 * writes a JSON Schema beside it (electron/agent/modelsSchema.ts) and the file
 * names it in `$schema`, so an editor completes the fields, describes them and marks what's wrong.
 *
 * The setup is what pi-ai's `createProvider()` takes, as far as JSON can say it (electron/agent/custom.ts makes the
 * call). Each entry of `providers` is one call: its key is the provider's `id`, and `name`, `baseUrl`, `headers`
 * and `models` are that call's options of the same names. Each model is a pi-ai `Model`, with its fields passed on
 * as written, so pi-ai's own documentation of custom providers (CUSTOM_MODELS_DOCS) is the documentation of them.
 * The app fills in what a `Model` needs and a viewer shouldn't have to type: `provider`, and `api` and `baseUrl`
 * from the provider's unless the model has its own, and a default for `name`, `reasoning`, `input`, `cost`,
 * `contextWindow` and `maxTokens`.
 *
 * Two of `createProvider()`'s options are code, so the setup names them instead. `api` is the name of the pi-ai
 * API implementation. And the provider's auth is its `apiKey`, the key itself, for a server that needs one. It's
 * in plain text in the file, which only the main process reads: the renderer, where mods run, is never given the
 * file's text and can't write it.
 */
/** The setup's file and its schema's, in the app's user data folder. */
export const CUSTOM_MODELS_FILE = 'models.json';
export const CUSTOM_MODELS_SCHEMA_FILE = 'models.schema.json';
/** EXAMPLE_CUSTOM_MODELS as a file, beside the two, for the viewer's coding agent to read (customModelsPrompt). */
export const CUSTOM_MODELS_EXAMPLE_FILE = 'models.example.json';

/**
 * The release of pi the app is built on: `@earendil-works/pi-ai` and `pi-durable` in package.json, which are
 * released together. Changed with them: a test holds it to the installed pi-ai.
 */
export const PI_VERSION = '1.6.1';

/** pi-ai's documentation of custom providers and their models, as of that release, which Advanced points to. */
export const CUSTOM_MODELS_DOCS = `https://github.com/earendil-works/pi/blob/v${PI_VERSION}/packages/ai/README.md#custom-providers`;

/** The APIs of pi-ai the app has wired in. pi has more. */
export const CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type CustomApi = (typeof CUSTOM_APIS)[number];

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface CustomModel {
  id: string;
  /** Shown in the panel. Default: the id. */
  name?: string;
  /** Overrides the provider's. */
  api?: CustomApi;
  /** Overrides the provider's. */
  baseUrl?: string;
  /** Whether it can think: pi then offers its thinking levels. Default false. */
  reasoning?: boolean;
  /** pi's map from its thinking levels to the server's values. A null marks a level the model doesn't have. */
  thinkingLevelMap?: Partial<Record<(typeof LEVELS)[number], string | null>>;
  /** Default `["text"]`. */
  input?: ('text' | 'image')[];
  /** Tokens. Default 128000. */
  contextWindow?: number;
  /** Tokens. Default 16384. */
  maxTokens?: number;
  /** Sent with this model's requests, over the provider's. */
  headers?: Record<string, string>;
  /** These are pi's own shapes, passed on as written. */
  inputLimits?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  promptCache?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface CustomProvider {
  /** Shown in the panel. Default: the provider's key. */
  name?: string;
  /** Where the server is, for each model that names none of its own. */
  baseUrl?: string;
  /** The API its models speak, for each that names none of its own. Default `openai-completions`, which every local server speaks. */
  api?: CustomApi;
  /** Sent with every request. */
  headers?: Record<string, string>;
  /** The API key, for a server that needs one. */
  apiKey?: string;
  /** pi's compatibility overrides, for each model that sets none of its own. */
  compat?: Record<string, unknown>;
  models: CustomModel[];
}

export interface CustomModels {
  /** Where the file's schema is, for an editor. The app doesn't read it. */
  $schema?: string;
  providers: Record<string, CustomProvider>;
}

/**
 * What a new file starts with: one model on a local Ollama, to change into the viewer's own. JSON has no comments
 * to say it's only an example, so its key and name say so, wherever the panel lists it.
 */
export const EXAMPLE_CUSTOM_MODELS: CustomModels = {
  $schema: `./${CUSTOM_MODELS_SCHEMA_FILE}`,
  providers: {
    'example-ollama': {
      name: 'Ollama (example)',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'qwen3:14b', name: 'Qwen3 14B', reasoning: true, contextWindow: 40960, maxTokens: 8192 }],
    },
  },
};

/** Where the setup's files are, as full paths: the file itself, and the schema and example the app writes beside it. */
export interface CustomModelsPaths {
  path: string;
  exists: boolean;
  schema: string;
  example: string;
}

/**
 * A prompt for the viewer's own coding agent, to have it write models.json: Advanced copies it. It says what the
 * app is, where the three files are, to settle with the viewer which model to connect before writing anything, and
 * what the file must hold. A key is handled the way the viewer and their agent already do it, if they have a way.
 */
export function customModelsPrompt(files: CustomModelsPaths): string {
  return `Help me set up a model of my own, such as a local one, for oh-my-f1-viewer (OMFV). OMFV is a desktop F1 TV player with an agent built on pi-ai. The agent works through tool calls.

OMFV reads the models I set up by hand from one file:
  ${files.path}  (${files.exists ? 'it exists: read it first' : 'not made yet'})

Two files beside it say what goes in it. Read both before you write anything:
  ${files.schema}
      Its JSON Schema: every field, what it means and its default.
  ${files.example}
      A working example, for a model on Ollama.

FIRST, work out with me which model to connect. Don't write the file yet.
1. Ask which server I run (Ollama, LM Studio, llama.cpp, vLLM, another), or look for one running on this machine.
2. Find its base URL and list the models it has (GET <baseUrl>/models on an OpenAI-compatible server). Show me the list and ask which to use.
3. For the model I pick, find the context window the server loads it with, and whether it calls tools, thinks, and takes images. Ask me what you can't find out. If it can't call tools, tell me: OMFV's agent won't work with it.
4. Ask whether the server needs an API key. If we already have a way you handle my keys and secrets (from my instructions to you, your memory, or earlier in this conversation), use that way. Otherwise don't ask me for the key.

THEN write models.json:
- Start from the example, and keep "$schema": "./${CUSTOM_MODELS_SCHEMA_FILE}" at the top.
- Use only fields the schema has. OMFV refuses the whole file over one unknown field.
- If the file already has providers, keep them and add to them.
- A provider's key is lowercase letters, digits, - or _, and not the name of a provider OMFV has built in, such as "openai" or "anthropic".
- Set contextWindow to what the server loads the model with, not the most the model can take.
- The key goes in "apiKey", as plain text: OMFV reads it from nowhere else. Put it there the way we agreed, if we have one. If we don't, write "apiKey": "PUT-YOUR-KEY-HERE" and tell me to replace it. Leave apiKey out for a server that needs none.
- Remove the example provider unless it's the one I'm setting up.

AFTER you save, there is nothing to restart: OMFV reads the file again on each save. Tell me to open /settings-agent in OMFV. My provider is listed under Advanced, where I choose its model. If the file has a mistake, Advanced lists what's wrong, and "Copy errors" there copies the list: ask me to paste it to you, then fix the file.

The format follows pi-ai's createProvider():
${CUSTOM_MODELS_DOCS}
`;
}

/** What's wrong with models.json, with where the file is, to paste to the agent that wrote it: Advanced copies it. */
export function customModelsErrorsText(file: string, errors: string[]): string {
  return [`OMFV isn't using ${file}. ${errors.length === 1 ? 'This is' : 'These are'} wrong with it:`, ...errors.map((line) => `- ${line}`), ''].join('\n');
}

export const MAX_CUSTOM_PROVIDERS = 10;
export const MAX_CUSTOM_MODELS = 50;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

export const PROVIDER_KEYS = ['name', 'baseUrl', 'api', 'apiKey', 'headers', 'compat', 'models'];
export const MODEL_KEYS = [
  'id',
  'name',
  'api',
  'baseUrl',
  'reasoning',
  'thinkingLevelMap',
  'input',
  'inputLimits',
  'cost',
  'promptCache',
  'contextWindow',
  'maxTokens',
  'samplingParams',
  'samplingParamsByThinkingLevel',
  'headers',
  'compat',
];
/** A model's fields that are pi's own objects, checked only to be objects. */
const MODEL_OBJECTS = ['inputLimits', 'cost', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel', 'compat'];
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const quoted = (keys: string[]) => keys.map((k) => `"${k}"`).join(', ');

export interface ParsedCustomModels {
  /** Null when there's nothing set up, or when anything is wrong: a config is used whole or not at all. */
  config: CustomModels | null;
  /** Each problem, naming where it is, in the viewer's words. */
  errors: string[];
}

/**
 * Checks a config, as parsed from the file. `reserved` are provider ids
 * the app already has, which a custom one can't take. Unknown fields are errors, so a typo isn't silently ignored.
 */
export function parseCustomModels(value: unknown, reserved: readonly string[] = []): ParsedCustomModels {
  const errors: string[] = [];
  if (value === undefined || value === null) return { config: null, errors };
  if (!isObject(value)) return { config: null, errors: ['The setup must be a JSON object with "providers" in it.'] };
  const extra = Object.keys(value).filter((k) => k !== 'providers' && k !== '$schema');
  if (extra.length) errors.push(`Unknown field ${quoted(extra)}: only "providers" and "$schema" go at the top.`);
  if (value.$schema !== undefined && typeof value.$schema !== 'string') errors.push('"$schema" must be text.');
  if (!isObject(value.providers)) {
    errors.push('"providers" must be an object, with one entry for each server.');
    return { config: null, errors };
  }
  const entries = Object.entries(value.providers);
  if (entries.length > MAX_CUSTOM_PROVIDERS) errors.push(`At most ${MAX_CUSTOM_PROVIDERS} providers.`);
  const providers: Record<string, CustomProvider> = {};
  const checkHeaders = (where: string, headers: unknown) => {
    if (headers !== undefined && (!isObject(headers) || Object.values(headers).some((h) => typeof h !== 'string'))) errors.push(`${where} must be an object of text values.`);
  };
  for (const [id, raw] of entries) {
    const at = `providers.${id}`;
    if (!PROVIDER_ID.test(id)) errors.push(`${at}: a provider's key must be lowercase letters, digits, - or _, up to 40 long.`);
    else if (reserved.includes(id)) errors.push(`${at}: "${id}" is already one of the app's providers. Give it another key.`);
    if (!isObject(raw)) {
      errors.push(`${at} must be an object.`);
      continue;
    }
    const unknown = Object.keys(raw).filter((k) => !PROVIDER_KEYS.includes(k));
    if (unknown.length) errors.push(`${at}: unknown field ${quoted(unknown)}. Known: ${PROVIDER_KEYS.join(', ')}.`);
    if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim())) errors.push(`${at}.name must be text.`);
    if (raw.api !== undefined && !CUSTOM_APIS.includes(raw.api as CustomApi)) errors.push(`${at}.api must be one of ${CUSTOM_APIS.join(', ')}.`);
    if (raw.baseUrl !== undefined && (typeof raw.baseUrl !== 'string' || !validUrl(raw.baseUrl))) errors.push(`${at}.baseUrl must be an http or https URL, like http://localhost:11434/v1.`);
    checkHeaders(`${at}.headers`, raw.headers);
    if (raw.apiKey !== undefined && (typeof raw.apiKey !== 'string' || !raw.apiKey.trim())) errors.push(`${at}.apiKey must be the key, as text. Leave it out for a server that needs none.`);
    if (raw.compat !== undefined && !isObject(raw.compat)) errors.push(`${at}.compat must be an object.`);
    if (!Array.isArray(raw.models) || raw.models.length === 0) {
      errors.push(`${at}.models must list at least one model.`);
      continue;
    }
    if (raw.models.length > MAX_CUSTOM_MODELS) errors.push(`${at}.models: at most ${MAX_CUSTOM_MODELS}.`);
    const seen = new Set<string>();
    const models = raw.models.flatMap((m, i): CustomModel[] => {
      const where = `${at}.models[${i}]`;
      if (!isObject(m)) {
        errors.push(`${where} must be an object.`);
        return [];
      }
      const unknownModel = Object.keys(m).filter((k) => !MODEL_KEYS.includes(k));
      if (unknownModel.length) errors.push(`${where}: unknown field ${quoted(unknownModel)}. Known: ${MODEL_KEYS.join(', ')}.`);
      if (typeof m.id !== 'string' || !m.id.trim()) errors.push(`${where}.id must be the model's id on the server.`);
      else if (seen.has(m.id)) errors.push(`${where}.id: "${m.id}" is listed twice.`);
      else seen.add(m.id);
      if (m.name !== undefined && (typeof m.name !== 'string' || !m.name.trim())) errors.push(`${where}.name must be text.`);
      if (m.api !== undefined && !CUSTOM_APIS.includes(m.api as CustomApi)) errors.push(`${where}.api must be one of ${CUSTOM_APIS.join(', ')}.`);
      if (m.baseUrl !== undefined && (typeof m.baseUrl !== 'string' || !validUrl(m.baseUrl))) errors.push(`${where}.baseUrl must be an http or https URL.`);
      else if (m.baseUrl === undefined && raw.baseUrl === undefined) errors.push(`${where} needs a "baseUrl", its own or the provider's, like http://localhost:11434/v1.`);
      if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') errors.push(`${where}.reasoning must be true or false.`);
      if (m.input !== undefined && (!Array.isArray(m.input) || !m.input.includes('text') || m.input.some((x) => x !== 'text' && x !== 'image'))) {
        errors.push(`${where}.input must be ["text"] or ["text", "image"].`);
      }
      if (m.contextWindow !== undefined && !positive(m.contextWindow)) errors.push(`${where}.contextWindow must be a whole number of tokens.`);
      if (m.maxTokens !== undefined && !positive(m.maxTokens)) errors.push(`${where}.maxTokens must be a whole number of tokens.`);
      if (
        m.thinkingLevelMap !== undefined &&
        (!isObject(m.thinkingLevelMap) ||
          Object.entries(m.thinkingLevelMap).some(([k, v]) => !(LEVELS as readonly string[]).includes(k) || (v !== null && typeof v !== 'string')))
      ) {
        errors.push(`${where}.thinkingLevelMap maps ${LEVELS.join(', ')} to text, or null for a level it doesn't have.`);
      }
      checkHeaders(`${where}.headers`, m.headers);
      for (const k of MODEL_OBJECTS) if (m[k] !== undefined && !isObject(m[k])) errors.push(`${where}.${k} must be an object.`);
      return [m as unknown as CustomModel];
    });
    providers[id] = { ...(raw as unknown as CustomProvider), models };
  }
  if (errors.length) return { config: null, errors };
  return { config: entries.length ? { ...(typeof value.$schema === 'string' ? { $schema: value.$schema } : {}), providers } : null, errors };
}

/** Parses the file's text. Empty text, or `{}`, means nothing is set up. */
export function parseCustomModelsText(text: string, reserved: readonly string[] = []): ParsedCustomModels {
  if (!text.trim()) return { config: null, errors: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { config: null, errors: [`It isn't valid JSON: ${(e as Error).message}`] };
  }
  if (isObject(value) && Object.keys(value).length === 0) return { config: null, errors: [] };
  return parseCustomModels(value, reserved);
}

function validUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
