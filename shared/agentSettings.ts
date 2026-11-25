/**
 * The agent's settings: the provider, model and thinking level `/settings-agent` chose, and a run policy
 * that's only changed by hand. They're under `agent` in the app's settings file, `<userData>/omfv-settings.json`
 * (electron/settings.ts). To change the policy, edit it while the app is closed, for example:
 *
 *   "agent": { "provider": "openai", "model": "gpt-6.1-terra", "thinking": "medium", "compaction": { "reserveTokens": 2000 } }
 *
 * Models set up by hand aren't here: they're in a file of their own, models.json (shared/customModels.ts).
 */
import type { ThinkingLevel } from './api';

export interface AgentSettings {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  retry?: { enabled?: boolean; maxRetries?: number };
}

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

/** Drops undefined fields, so a parsed value compares and saves the way it was written. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** What `value` says, with anything it gets wrong left out. Never null, so bad stored settings don't stop the agent. */
export function parseAgentSettings(value: unknown): AgentSettings {
  if (!isObject(value)) return {};
  const thinking = THINKING_LEVELS.find((level) => level === value.thinking);
  const compaction = isObject(value.compaction)
    ? defined({ enabled: flag(value.compaction.enabled), reserveTokens: count(value.compaction.reserveTokens), keepRecentTokens: count(value.compaction.keepRecentTokens) })
    : undefined;
  const retry = isObject(value.retry) ? defined({ enabled: flag(value.retry.enabled), maxRetries: count(value.retry.maxRetries) }) : undefined;
  return defined({ provider: string(value.provider), model: string(value.model), thinking, compaction, retry });
}
