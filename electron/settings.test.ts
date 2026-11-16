import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { SettingsFile, setUiState, uiState } = await import('./settings');

let dir = '';
const file = () => path.join(dir, 'f1a-settings.json');
const onDisk = () => JSON.parse(readFileSync(file(), 'utf8')) as unknown;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'f1a-settings-test-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the settings file', () => {
  it('starts empty with no file, and writes nothing until something changes', () => {
    const settings = new SettingsFile(file());
    expect(settings.get('agent')).toBeUndefined();
    settings.flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('starts empty from a file it cannot read, and replaces it at the first change', () => {
    writeFileSync(file(), '{not json');
    const settings = new SettingsFile(file());
    expect(settings.get('agent')).toBeUndefined();
    settings.set('agent', { provider: 'openai' });
    settings.flush();
    expect(onDisk()).toEqual({ agent: { provider: 'openai' } });
  });

  it('keeps changes, writing them together, and reads them back', async () => {
    const settings = new SettingsFile(file());
    settings.set('agent', { provider: 'openai' });
    settings.set('ui', { volume: 0.4 });
    expect(readdirSync(dir)).toEqual([]);
    await vi.waitFor(() => expect(onDisk()).toEqual({ agent: { provider: 'openai' }, ui: { volume: 0.4 } }));
    expect(readdirSync(dir)).toEqual(['f1a-settings.json']);
    expect(new SettingsFile(file()).get('ui')).toEqual({ volume: 0.4 });
  });

  it('removes a key set to undefined', () => {
    const settings = new SettingsFile(file());
    settings.set('agent', { provider: 'openai' });
    settings.set('agent', undefined);
    settings.flush();
    expect(onDisk()).toEqual({});
  });
});

describe("the renderer's UI state", () => {
  it('is kept under ui, one key at a time, beside the rest', () => {
    const settings = new SettingsFile(file());
    settings.set('agent', { provider: 'openai' });
    setUiState('volume', { level: 0.4, lastHeard: 0.4 }, settings);
    setUiState('paletteHeight', 300, settings);
    setUiState('paletteHeight', undefined, settings);
    expect(uiState(settings)).toEqual({ volume: { level: 0.4, lastHeard: 0.4 } });
    expect(settings.get('agent')).toEqual({ provider: 'openai' });
  });

  it('is empty when the file holds something else there', () => {
    const settings = new SettingsFile(file());
    settings.set('ui', 'loud');
    expect(uiState(settings)).toEqual({});
  });
});
