import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CUSTOM_MODELS_DOCS, EXAMPLE_CUSTOM_MODELS, PI_VERSION, customModelsErrorsText, customModelsPrompt, parseCustomModels, parseCustomModelsText } from '../shared/customModels';

const RESERVED = ['openai', 'anthropic'];
const one = (provider: Record<string, unknown>, id = 'local') => ({
  providers: { [id]: { baseUrl: 'http://localhost:8080/v1', api: 'openai-completions', models: [{ id: 'm' }], ...provider } },
});

describe('parseCustomModels', () => {
  it("takes the example, and a provider with every field: createProvider()'s for the provider, and a pi-ai Model's for each model", () => {
    expect(parseCustomModels(EXAMPLE_CUSTOM_MODELS, RESERVED)).toEqual({ config: EXAMPLE_CUSTOM_MODELS, errors: [] });
    const full = {
      providers: {
        'lm-studio': {
          name: 'LM Studio',
          api: 'openai-responses',
          baseUrl: 'http://127.0.0.1:1234/v1',
          apiKey: 'sk-local',
          headers: { 'x-team': 'f1' },
          compat: { supportsDeveloperRole: false },
          models: [
            {
              id: 'gpt-oss-20b',
              name: 'GPT-OSS 20B',
              api: 'openai-completions',
              baseUrl: 'http://127.0.0.1:1235/v1',
              reasoning: true,
              thinkingLevelMap: { minimal: null, low: 'low' },
              input: ['text', 'image'],
              inputLimits: { maxRequestBytes: 1000000 },
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              promptCache: { short: 300 },
              contextWindow: 131072,
              maxTokens: 8192,
              samplingParams: { top_p: 0.9 },
              samplingParamsByThinkingLevel: { high: { temperature: 0.6 } },
              headers: { 'x-model': 'yes' },
              compat: {},
            },
          ],
        },
      },
    };
    expect(parseCustomModels(full, RESERVED)).toEqual({ config: full, errors: [] });
  });

  it('needs only a server and the id of each model', () => {
    const least = { providers: { local: { baseUrl: 'http://localhost:8080/v1', models: [{ id: 'm' }] } } };
    expect(parseCustomModels(least, RESERVED)).toEqual({ config: least, errors: [] });
  });

  it('lets each model name the server and API the provider does not', () => {
    const perModel = { providers: { mixed: { models: [{ id: 'a', api: 'anthropic-messages', baseUrl: 'http://localhost:1/v1' }] } } };
    expect(parseCustomModels(perModel, RESERVED).errors).toEqual([]);
    expect(parseCustomModels({ providers: { mixed: { models: [{ id: 'a' }] } } }, RESERVED).errors).toEqual([
      'providers.mixed.models[0] needs a "baseUrl", its own or the provider\'s, like http://localhost:11434/v1.',
    ]);
  });

  it('is nothing when nothing is set up', () => {
    expect(parseCustomModels(undefined)).toEqual({ config: null, errors: [] });
    expect(parseCustomModelsText('  ')).toEqual({ config: null, errors: [] });
    expect(parseCustomModelsText('{}')).toEqual({ config: null, errors: [] });
  });

  it('names each thing that is wrong, and uses none of it', () => {
    const { config, errors } = parseCustomModels(
      {
        providers: {
          ok: { baseUrl: 'http://localhost/v1', api: 'openai-completions', models: [{ id: 'a' }] },
          openai: { baseUrl: 'ftp://nope', api: 'grpc', model: [] },
          Bad: {
            baseUrl: 'http://x',
            api: 'openai-completions',
            models: [{ id: 'a' }, { id: 'a', contextWindow: 1.5, reasoning: 'yes', input: ['audio'], thinkingLevelMap: { loud: 'x' }, temperature: 1, cost: 3 }],
          },
        },
      },
      RESERVED,
    );
    expect(config).toBeNull();
    expect(errors).toEqual([
      'providers.openai: "openai" is already one of the app\'s providers. Give it another key.',
      'providers.openai: unknown field "model". Known: name, baseUrl, api, apiKey, headers, compat, models.',
      'providers.openai.api must be one of openai-completions, openai-responses, anthropic-messages.',
      'providers.openai.baseUrl must be an http or https URL, like http://localhost:11434/v1.',
      'providers.openai.models must list at least one model.',
      "providers.Bad: a provider's key must be lowercase letters, digits, - or _, up to 40 long.",
      'providers.Bad.models[1]: unknown field "temperature". Known: id, name, api, baseUrl, reasoning, thinkingLevelMap, input, inputLimits, cost, promptCache, contextWindow, maxTokens, samplingParams, samplingParamsByThinkingLevel, headers, compat.',
      'providers.Bad.models[1].id: "a" is listed twice.',
      'providers.Bad.models[1].reasoning must be true or false.',
      'providers.Bad.models[1].input must be ["text"] or ["text", "image"].',
      'providers.Bad.models[1].contextWindow must be a whole number of tokens.',
      'providers.Bad.models[1].thinkingLevelMap maps off, minimal, low, medium, high, xhigh, max to text, or null for a level it doesn\'t have.',
      'providers.Bad.models[1].cost must be an object.',
    ]);
  });

  it('takes a key as text, and headers as text values', () => {
    expect(parseCustomModels(one({ apiKey: 'sk-123' })).errors).toEqual([]);
    const key = 'providers.local.apiKey must be the key, as text. Leave it out for a server that needs none.';
    expect(parseCustomModels(one({ apiKey: ' ' })).errors).toEqual([key]);
    expect(parseCustomModels(one({ apiKey: 7 })).errors).toEqual([key]);
    expect(parseCustomModels(one({ apiKeyEnv: 'MY_KEY' })).errors[0]).toMatch(/unknown field "apiKeyEnv"/);
    expect(parseCustomModels(one({ headers: { 'x-a': 1 } })).errors).toEqual(['providers.local.headers must be an object of text values.']);
  });

  it('says why text is not JSON', () => {
    const { config, errors } = parseCustomModelsText('{ "providers": ');
    expect(config).toBeNull();
    expect(errors[0]).toMatch(/^It isn't valid JSON: /);
    expect(parseCustomModelsText('[]').errors).toEqual(['The setup must be a JSON object with "providers" in it.']);
    expect(parseCustomModelsText('{ "providers": {}, "version": 1 }').errors).toEqual(['Unknown field "version": only "providers" and "$schema" go at the top.']);
  });

  it('starts a new file from an example that says it is one, by its key and its name', () => {
    const text = JSON.stringify(EXAMPLE_CUSTOM_MODELS, null, 2);
    expect(parseCustomModelsText(text, RESERVED)).toEqual({ config: EXAMPLE_CUSTOM_MODELS, errors: [] });
    expect(Object.entries(EXAMPLE_CUSTOM_MODELS.providers).map(([id, p]) => [id, p.name])).toEqual([['example-ollama', 'Ollama (example)']]);
    expect(EXAMPLE_CUSTOM_MODELS.$schema).toBe('./models.schema.json');
  });
});

describe('what Advanced copies for a coding agent', () => {
  const files = { path: '/u/models.json', exists: false, schema: '/u/models.schema.json', example: '/u/models.example.json' };

  it('is a prompt naming the three files, with the model settled first and the key handled as already agreed', () => {
    const prompt = customModelsPrompt(files);
    expect(prompt).toContain('  /u/models.json  (not made yet)');
    expect(prompt).toContain('  /u/models.schema.json\n');
    expect(prompt).toContain('  /u/models.example.json\n');
    expect(prompt.indexOf('FIRST, work out with me which model to connect')).toBeLessThan(prompt.indexOf('THEN write models.json'));
    expect(prompt).toContain('If we already have a way you handle my keys and secrets');
    expect(prompt).toContain('"apiKey": "PUT-YOUR-KEY-HERE"');
    expect(prompt).toContain(CUSTOM_MODELS_DOCS);
    expect(customModelsPrompt({ ...files, exists: true })).toContain('  /u/models.json  (it exists: read it first)');
  });

  it('is the errors with where the file is', () => {
    expect(customModelsErrorsText('/u/models.json', ['a is wrong.', 'b is wrong.'])).toBe("OMFV isn't using /u/models.json. These are wrong with it:\n- a is wrong.\n- b is wrong.\n");
    expect(customModelsErrorsText('/u/models.json', ['a is wrong.'])).toMatch(/^OMFV isn't using \/u\/models.json. This is wrong with it:\n- a/);
  });
});

describe('PI_VERSION', () => {
  it('is the pi-ai and pi-durable installed, so the documentation linked is of the release in use', () => {
    const installed = (name: string) => JSON.parse(readFileSync(path.join(__dirname, '..', 'node_modules', '@earendil-works', name, 'package.json'), 'utf8')).version;
    expect(installed('pi-ai')).toBe(PI_VERSION);
    expect(installed('pi-durable')).toBe(PI_VERSION);
    expect(CUSTOM_MODELS_DOCS).toBe(`https://github.com/earendil-works/pi/blob/v${PI_VERSION}/packages/ai/README.md#custom-providers`);
  });
});
