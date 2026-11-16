import { describe, expect, it } from 'vitest';
import { parseAgentSettings } from '../shared/agentSettings';

describe('parseAgentSettings', () => {
  it('keeps what it knows', () => {
    const settings = { provider: 'openai', model: 'gpt-6-luna', thinking: 'high', compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 2 } };
    expect(parseAgentSettings(settings)).toEqual(settings);
  });

  it('leaves out what is wrong or unknown, and never fails', () => {
    expect(parseAgentSettings({ provider: '', model: 7, thinking: 'loud', compaction: { enabled: 'yes', reserveTokens: -1, keepRecentTokens: 1.5 }, retry: [], extra: 1 })).toEqual({ compaction: {} });
    expect(parseAgentSettings(null)).toEqual({});
    expect(parseAgentSettings('openai')).toEqual({});
  });
});
