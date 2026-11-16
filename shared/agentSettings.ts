/**
 * The agent's settings: the provider, model and thinking level `/settings-agent` chose, and a run policy
 * that's only changed by hand. The renderer keeps them with the rest of the app's UI state (localStorage,
 * `f1a.agent`, src/shell/persistAgentSettings.ts) and hands them to the main process, which runs the agent. From devtools:
 *
 *   localStorage.setItem('f1a.agent', JSON.stringify({ ...JSON.parse(localStorage.getItem('f1a.agent')), compaction: { reserveTokens: 2000 } }))
 *
 * applies from the next start, or a reload.
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
