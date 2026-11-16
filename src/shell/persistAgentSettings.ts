/** Keeps the agent's settings with the rest of the UI state across restarts. See shared/agentSettings.ts. */
import { parseAgentSettings } from '../../shared/agentSettings';
import { host } from '../host';
import { loadUiState, saveUiState, type UiStorage } from './uiState';

const KEY = 'agent';

/**
 * Hands main the saved settings and keeps whatever it changes. Call it once, before anything asks about the
 * agent: IPC keeps order, so every later call sees them.
 */
export function restoreAgentSettings(storage?: UiStorage | null): void {
  host.agent.onSettings((settings) => saveUiState(KEY, settings, storage));
  host.agent.useSettings(loadUiState(KEY, parseAgentSettings, {}, storage)).catch((e: Error) => console.warn('[agent] settings:', e.message));
}
