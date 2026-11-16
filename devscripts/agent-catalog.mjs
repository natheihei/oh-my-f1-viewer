// Lists what the installed pi offers, to pick from for electron/agent/supported.ts: each provider's id and
// ways to connect, then each chat model's id, name, context window and thinking levels.
//
//   node devscripts/agent-catalog.mjs            every provider
//   node devscripts/agent-catalog.mjs anthropic  one provider's models
//
// It reads pi-ai's bundled catalog with an empty credential store: no credentials, and no network.
// https://pi.dev/models can be newer than the installed pi.
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const only = process.argv[2];
const models = builtinModels();
for (const provider of models.getProviders()) {
  if (only && provider.id !== only) continue;
  const ways = [
    provider.auth.oauth ? `oauth (${provider.auth.oauth.loginLabel ?? provider.auth.oauth.name})` : null,
    provider.auth.apiKey?.login ? 'api_key' : null,
  ].filter(Boolean);
  const list = models.getModels(provider.id);
  console.log(`${provider.id}  ${provider.name}  ways: ${ways.join(', ') || 'none'}  models: ${list.length}`);
  if (!only) continue;
  for (const m of list) {
    console.log(`  ${m.id.padEnd(36)} ${m.name.padEnd(28)} ${String(m.contextWindow).padStart(8)}  ${getSupportedThinkingLevels(m).join(' ')}`);
  }
}
if (!only) console.log('\nPass a provider id to list its models.');
