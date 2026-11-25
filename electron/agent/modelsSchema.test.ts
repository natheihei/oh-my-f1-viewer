import { describe, expect, it } from 'vitest';
import { CUSTOM_APIS, EXAMPLE_CUSTOM_MODELS, MODEL_KEYS, PROVIDER_KEYS } from '../../shared/customModels';
import { customModelsSchema } from './modelsSchema';

type Schema = { properties: Record<string, Schema>; additionalProperties: Schema | boolean; items: Schema; anyOf: Schema[]; description?: string; enum?: string[] };

describe('customModelsSchema', () => {
  it('lists the fields the app reads, no more and no fewer, each with a description', async () => {
    const schema = (await customModelsSchema()) as unknown as Schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['$schema', 'providers']);
    expect(Object.keys(EXAMPLE_CUSTOM_MODELS).every((key) => key in schema.properties)).toBe(true);
    const provider = schema.properties.providers.additionalProperties as Schema;
    const model = provider.properties.models.items;
    expect(Object.keys(provider.properties).sort()).toEqual([...PROVIDER_KEYS].sort());
    expect(Object.keys(model.properties).sort()).toEqual([...MODEL_KEYS].sort());
    for (const fields of [provider.properties, model.properties]) {
      for (const [name, field] of Object.entries(fields)) expect(field.description, name).toBeTruthy();
    }
    expect(provider.additionalProperties).toBe(false);
    expect(model.additionalProperties).toBe(false);
    expect(provider.properties.api.enum).toEqual([...CUSTOM_APIS]);
  });

  it("takes a model's own objects from pi-ai, so an editor describes what the installed pi-ai takes", async () => {
    const schema = (await customModelsSchema()) as unknown as Schema;
    const model = (schema.properties.providers.additionalProperties as Schema).properties.models.items;
    // One schema for each API the app has wired in.
    expect(model.properties.compat.anyOf).toHaveLength(CUSTOM_APIS.length);
    expect(model.properties.compat.anyOf[0].properties.supportsDeveloperRole.description).toBeTruthy();
    expect(Object.keys(model.properties.cost.properties)).toEqual(expect.arrayContaining(['input', 'output', 'cacheRead', 'cacheWrite']));
    expect(Object.keys(model.properties.thinkingLevelMap.properties)).toEqual(expect.arrayContaining(['off', 'high', 'max']));
    // It's plain JSON, to write to a file.
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});
