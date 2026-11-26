import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { allowedProps, BUILT_IN_TILES, COUNT_CAP } from '../shared/telemetry';
import type { Settings } from './settings';

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.1.0', getPath: () => '/nowhere' } }));
vi.mock('posthog-node', () => ({ PostHog: class {} }));

const { Telemetry, posthogKey, readSaved } = await import('./telemetry');

class MemorySettings implements Settings {
  values: Record<string, unknown> = {};
  get(key: string) {
    return this.values[key];
  }
  set(key: string, value: unknown) {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
  }
}

function setup(options: { key?: string | null; dev?: boolean; env?: Record<string, string>; saved?: unknown } = {}) {
  const settings = new MemorySettings();
  if (options.saved) settings.values.telemetry = options.saved;
  const sent: { id: string; event: string; properties: Record<string, unknown> }[] = [];
  const shutdown = vi.fn(async () => {});
  let clock = 0;
  const telemetry = new Telemetry(settings, {
    key: options.key === undefined ? 'phc_test' : options.key,
    dev: options.dev ?? false,
    env: options.env ?? {},
    common: { build: 'release', release: '20261120.1', os: 'linux', arch: 'x64', install: 'appimage' },
    sink: () => ({ capture: (id, event, properties) => sent.push({ id, event, properties }), shutdown }),
    now: () => clock,
  });
  return { settings, sent, shutdown, telemetry, tick: (ms: number) => (clock += ms) };
}

describe('allowedProps', () => {
  it('drops an event that is not on the list', () => {
    expect(allowedProps('keylogger', { text: 'hi' })).toBeNull();
    expect(allowedProps('toString', {})).toBeNull();
  });

  it('keeps only listed properties that fit their kind', () => {
    expect(allowedProps('session_opened', { session_type: 'race', live: true, year: 2026, title: '2026 Mexico City Grand Prix' })).toEqual({
      session_type: 'race',
      live: true,
      year: 2026,
    });
    expect(allowedProps('session_opened', { session_type: 'a race I liked', live: 'yes', year: 1950 })).toEqual({});
    expect(allowedProps('tile_added', { tile: 'my_secret_mod' })).toEqual({});
    expect(allowedProps('command_used', { command: '/build a lap stepper' })).toEqual({});
  });

  it('rounds and caps numbers', () => {
    expect(allowedProps('session_closed', { minutes: 93.4 })).toEqual({ minutes: 95 });
    expect(allowedProps('session_closed', { minutes: 10_000 })).toEqual({ minutes: 600 });
    expect(allowedProps('build_ended', { how: 'save', mods: 1e6 })).toEqual({ how: 'save', mods: COUNT_CAP });
    expect(allowedProps('build_ended', { mods: -1 })).toEqual({});
  });

  it('takes names, never text, for ids and tools', async () => {
    expect(allowedProps('agent_tool', { tool: 'suggest_tiles', ok: true })).toEqual({ tool: 'suggest_tiles', ok: true });
    expect(allowedProps('agent_tool', { tool: 'show me the race' })).toEqual({});
    expect(allowedProps('agent_connected', { provider: 'openai', way: 'oauth' })).toEqual({ provider: 'openai', way: 'oauth' });
    expect(allowedProps('agent_connected', { provider: 'opencode-go', way: 'api_key' })).toEqual({ provider: 'opencode-go', way: 'api_key' });
    expect(allowedProps('agent_turn', { provider: 'openrouter', model: 'google/gemini-4-neon' })).toEqual({ provider: 'openrouter', model: 'google/gemini-4-neon' });
    expect(allowedProps('agent_connected', { provider: 'me@example.com' })).toEqual({});
    expect(allowedProps('agent_turn', { model: 'https://example.com' })).toEqual({});
    expect(allowedProps('agent_turn', { model: '/etc/passwd' })).toEqual({});
    expect(allowedProps('agent_turn', { model: 'a'.repeat(65) })).toEqual({});

    const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
    const catalog = builtinModels();
    for (const p of catalog.getProviders()) {
      expect(allowedProps('agent_connected', { provider: p.id }), p.id).toEqual({ provider: p.id });
      for (const m of catalog.getModels(p.id)) {
        expect(allowedProps('agent_turn', { provider: p.id, model: m.id }), `${p.id}/${m.id}`).toEqual({ provider: p.id, model: m.id });
      }
    }
  });

  it('lists every built-in component', () => {
    const dir = path.join(__dirname, '..', 'src', 'components');
    const components = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory());
    expect([...BUILT_IN_TILES].sort()).toEqual(components.sort());
  });
});

describe('Telemetry', () => {
  it('keeps events until the notice has shown, then sends them under a random id', () => {
    const { sent, telemetry, settings } = setup();
    telemetry.start(false);
    telemetry.track('app_started', { f1tv_signed_in: true, agent_ready: false, mods: 2 });
    expect(sent).toEqual([]);
    expect(telemetry.needsNotice()).toBe(true);

    telemetry.noticed();
    expect(sent.map((s) => s.event)).toEqual(['app_installed', 'app_started']);
    const id = readSaved(settings.values.telemetry).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]).toEqual({
      id,
      event: 'app_started',
      properties: { f1tv_signed_in: true, agent_ready: false, mods: 2, build: 'release', release: '20261120.1', os: 'linux', arch: 'x64', install: 'appimage', $process_person_profile: false },
    });
    expect(telemetry.needsNotice()).toBe(false);
  });

  it('says it is an install once, on the first start that sends', () => {
    const { sent, telemetry } = setup({ saved: { noticed: true } });
    telemetry.start(true);
    telemetry.start(true);
    expect(sent.map((s) => [s.event, s.properties.existing_profile])).toEqual([['app_installed', true]]);
  });

  it('sends nothing from a release without a key, or with the environment against it', () => {
    for (const options of [{ key: null }, { env: { OMFV_TELEMETRY: '0' } }, { env: { DO_NOT_TRACK: '1' } }]) {
      const { sent, telemetry, settings } = setup({ ...options, saved: { noticed: true } });
      telemetry.start(false);
      telemetry.track('build_started');
      expect(sent).toEqual([]);
      expect(settings.values.telemetry).toEqual({ noticed: true });
      expect(telemetry.needsNotice()).toBe(false);
      expect(telemetry.status().blocked).not.toBeNull();
    }
  });

  it('turning it off forgets the id, and on again makes a new one', () => {
    const { sent, telemetry, settings, shutdown } = setup({ saved: { noticed: true } });
    telemetry.start(false);
    const first = readSaved(settings.values.telemetry).id;
    expect(telemetry.setEnabled(false)).toMatchObject({ enabled: false, id: null });
    expect(settings.values.telemetry).toEqual({ enabled: false, noticed: true });
    expect(shutdown).toHaveBeenCalled();
    telemetry.track('build_started');
    expect(sent.map((s) => s.event)).toEqual(['app_installed']);

    const again = telemetry.setEnabled(true);
    expect(again.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(again.id).not.toBe(first);
  });

  it('a dev build counts without a key, for its log', () => {
    const { sent, telemetry } = setup({ key: null, dev: true, saved: { noticed: true } });
    telemetry.start(false);
    expect(telemetry.status().blocked).toBeNull();
    expect(sent.map((s) => s.event)).toEqual(['app_installed']);
  });

  it('takes from the renderer only the events it may send, and counts a session in minutes', () => {
    const { sent, telemetry, tick } = setup({ saved: { noticed: true, id: '00000000-0000-4000-8000-000000000000' } });
    telemetry.fromRenderer('agent_turn', { mode: 'view' });
    telemetry.fromRenderer('build_started', {});
    telemetry.fromRenderer('session_opened', { session_type: 'race', live: false, year: 2026 });
    tick(42 * 60_000);
    telemetry.fromRenderer('session_closed', { minutes: 9999 });
    telemetry.fromRenderer('session_closed', {});
    expect(sent.map((s) => [s.event, s.event === 'session_closed' ? s.properties.minutes : null])).toEqual([
      ['session_opened', null],
      ['session_closed', 40],
    ]);
  });

  it('on quit, ends the open session and sends what is waiting', async () => {
    const { sent, telemetry, tick, shutdown } = setup({ saved: { noticed: true, id: '00000000-0000-4000-8000-000000000000' } });
    telemetry.fromRenderer('session_opened', { session_type: 'qualifying', live: true, year: 2026 });
    tick(61 * 60_000);
    await telemetry.close(1000);
    expect(sent.at(-1)).toMatchObject({ event: 'session_closed', properties: { minutes: 60 } });
    expect(shutdown).toHaveBeenCalledWith(1000);
  });
});

describe('posthogKey', () => {
  const pkg = (key: unknown) => () => JSON.stringify({ name: 'oh-my-f1-viewer', omfvPosthogKey: key });

  it("a release takes the key its workflow packaged, and ignores the environment's", () => {
    expect(posthogKey(true, { OMFV_POSTHOG_KEY: 'phc_mine' }, pkg('phc_release'))).toBe('phc_release');
    expect(posthogKey(true, { OMFV_POSTHOG_KEY: 'phc_mine' }, pkg(''))).toBeNull();
    expect(posthogKey(true, {}, () => '{not json')).toBeNull();
  });

  it('a dev build takes it only from OMFV_POSTHOG_KEY', () => {
    expect(posthogKey(false, { OMFV_POSTHOG_KEY: 'phc_mine' }, pkg('phc_release'))).toBe('phc_mine');
    expect(posthogKey(false, {}, pkg('phc_release'))).toBeNull();
    expect(posthogKey(false, { OMFV_POSTHOG_KEY: 'not a key' }, pkg(''))).toBeNull();
  });
});
