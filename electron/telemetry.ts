/**
 * Anonymous usage counts, sent to PostHog: how many installs and starts there are, sessions opened and for how
 * long, tiles added, the agent's turns and tools, build mode. Never who the viewer is or what they type. Every
 * event is checked against shared/telemetry.ts first, and docs/TELEMETRY.md lists them for people.
 *
 * - It's on unless turned off, with a notice: nothing is sent until the palette has shown it once. Turning it off
 *   with `/settings-usage` forgets the id, and OMFV_TELEMETRY=0 or DO_NOT_TRACK=1 stops it too.
 * - Events are counted by a random id kept under `telemetry` in the settings, and by nothing else: it isn't the
 *   `omfv-install-id` a model provider's sign-in is given, and no person profile is made. No IP or place is kept:
 *   the SDK doesn't look it up, and the PostHog project discards it.
 * - Each event says `build: release` or `build: dev`. A release sends with the key its workflow put into the packaged
 *   package.json. A dev build, one that isn't a release, sends only with the key in OMFV_POSTHOG_KEY, as on the
 *   maker's machine, so a fork, CI or a check script's instance sends nothing. A dev build also logs each event to the
 *   console, key or not.
 */
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PostHog } from 'posthog-node';
import { releaseName } from '../shared/release';
import { allowedProps, RENDERER_EVENTS, type TelemetryEvent, type TelemetryProps, type TelemetryStatus } from '../shared/telemetry';
import { appSettings, type Settings } from './settings';

export const POSTHOG_HOST = 'https://us.i.posthog.com';
/** Events kept while the notice hasn't shown yet. More are dropped. */
const PENDING_CAP = 100;
/** The SDK sends what it has this often, or once it holds FLUSH_AT. */
const FLUSH_EVERY_MS = 60_000;
const FLUSH_AT = 20;
/** How long quitting waits for the last events to go. */
export const QUIT_FLUSH_MS = 2000;

/** What the settings keep under `telemetry`. */
export interface SavedTelemetry {
  /** Off only once turned off: missing is on. */
  enabled?: boolean;
  /** The random id events are counted by. Removed when it's turned off. */
  id?: string;
  /** The palette has said it's on, and how to turn it off. */
  noticed?: boolean;
}

export function readSaved(value: unknown): SavedTelemetry {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : undefined,
    id: typeof v.id === 'string' && /^[0-9a-f-]{36}$/.test(v.id) ? v.id : undefined,
    noticed: v.noticed === true ? true : undefined,
  };
}

/** Where events go: PostHog, and the console in a dev build. */
export interface Sink {
  capture(id: string, event: string, properties: Record<string, unknown>): void;
  /** Sends what's waiting, then stops: nothing more is captured. */
  shutdown(ms: number): Promise<void>;
}

function posthogSink(key: string): Sink {
  const client = new PostHog(key, {
    host: POSTHOG_HOST,
    flushAt: FLUSH_AT,
    flushInterval: FLUSH_EVERY_MS,
    disableGeoip: true,
    personProfiles: 'never',
  });
  client.on('error', (e: unknown) => console.warn('[telemetry]', (e as Error)?.message ?? e));
  return {
    capture: (distinctId, event, properties) => client.capture({ distinctId, event, properties, disableGeoip: true }),
    shutdown: (ms) => client.shutdown(ms),
  };
}

const consoleSink: Sink = {
  capture: (_id, event, properties) => console.log('[telemetry]', event, JSON.stringify(properties)),
  shutdown: async () => {},
};

/** A dev build logs each event, and sends it too once there's a key. A release only sends. */
function defaultSink(key: string | null, dev: boolean): Sink {
  const sinks = [...(dev ? [consoleSink] : []), ...(key ? [posthogSink(key)] : [])];
  return {
    capture: (...args) => sinks.forEach((s) => s.capture(...args)),
    shutdown: async (ms) => void (await Promise.all(sinks.map((s) => s.shutdown(ms)))),
  };
}

export interface TelemetryOptions {
  /** The PostHog project's key, or null while there's none. */
  key: string | null;
  /** Not a release: from a checkout, or packaged by hand. */
  dev: boolean;
  env: Record<string, string | undefined>;
  /** Sent with every event: which build, on what. */
  common: Record<string, string>;
  sink?: (key: string | null, dev: boolean) => Sink;
  now?: () => number;
}

export class Telemetry {
  private sink: Sink | null = null;
  private pending: { event: string; props: Record<string, unknown> }[] = [];
  private openedAt: number | null = null;
  private readonly now: () => number;

  constructor(
    private readonly settings: Settings,
    private readonly options: TelemetryOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  private get saved(): SavedTelemetry {
    return readSaved(this.settings.get('telemetry'));
  }

  private save(next: SavedTelemetry): void {
    this.settings.set('telemetry', Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
  }

  private get blocked(): TelemetryStatus['blocked'] {
    const { OMFV_TELEMETRY, DO_NOT_TRACK } = this.options.env;
    if (OMFV_TELEMETRY === '0' || OMFV_TELEMETRY === 'false' || (DO_NOT_TRACK && DO_NOT_TRACK !== '0')) return 'environment';
    // A dev build logs even without a key, so what it would send can be seen.
    return this.options.key || this.options.dev ? null : 'no-key';
  }

  /** Whether events are sent, or kept for the notice. */
  private get on(): boolean {
    return this.saved.enabled !== false && this.blocked === null;
  }

  /**
   * At start, before anything else writes the settings. The first start that sends makes the id, and says it's an
   * install. `existingProfile`: the profile was used before, by a build that didn't send.
   */
  start(existingProfile: boolean): void {
    if (!this.on || this.saved.id) return;
    this.save({ ...this.saved, id: randomUUID() });
    this.track('app_installed', { existing_profile: existingProfile });
  }

  status(): TelemetryStatus {
    const { enabled, id } = this.saved;
    return { enabled: enabled !== false, blocked: this.blocked, id: this.on ? (id ?? null) : null };
  }

  /** Whether the palette should say telemetry is on: once, the first time it would send. */
  needsNotice(): boolean {
    return this.on && !this.saved.noticed;
  }

  /** The palette has said so: what was kept goes now. */
  noticed(): void {
    if (!this.saved.noticed) this.save({ ...this.saved, noticed: true });
    const kept = this.pending;
    this.pending = [];
    for (const { event, props } of kept) this.send(event, props);
  }

  /** Turning it off forgets the id and what's waiting. Turning it on again makes a new id. */
  setEnabled(enabled: boolean): TelemetryStatus {
    if (enabled) {
      this.save({ enabled: true, id: this.saved.id ?? randomUUID(), noticed: true });
    } else {
      this.save({ enabled: false, noticed: true });
      this.pending = [];
      this.openedAt = null;
      const sink = this.sink;
      this.sink = null;
      void sink?.shutdown(0).catch(() => {});
    }
    return this.status();
  }

  track<E extends TelemetryEvent>(event: E, props: TelemetryProps<E> = {} as TelemetryProps<E>): void {
    if (!this.on) return;
    const allowed = allowedProps(event, props);
    if (!allowed) return;
    if (this.saved.noticed) this.send(event, allowed);
    else if (this.pending.length < PENDING_CAP) this.pending.push({ event, props: allowed });
  }

  /** An event the renderer sent: only those it may send, and a session's minutes are counted here. */
  fromRenderer(event: unknown, props: unknown): void {
    if (typeof event !== 'string' || !(RENDERER_EVENTS as readonly string[]).includes(event)) return;
    if (event === 'session_opened') {
      this.closeSession();
      this.openedAt = this.now();
    } else if (event === 'session_closed') {
      this.closeSession();
      return;
    }
    this.track(event as TelemetryEvent, props as TelemetryProps<TelemetryEvent>);
  }

  /** The open session ended: how long it was open. */
  private closeSession(): void {
    if (this.openedAt == null) return;
    const minutes = (this.now() - this.openedAt) / 60_000;
    this.openedAt = null;
    this.track('session_closed', { minutes });
  }

  /** On quit: ends the open session, and sends what's waiting, for up to `ms`. */
  async close(ms = QUIT_FLUSH_MS): Promise<void> {
    this.closeSession();
    const sink = this.sink;
    this.sink = null;
    await sink?.shutdown(ms).catch((e: Error) => console.warn('[telemetry] sending on quit:', e.message));
  }

  private send(event: string, props: Record<string, unknown>): void {
    const id = this.saved.id;
    if (!id) return;
    this.sink ??= (this.options.sink ?? defaultSink)(this.options.key, this.options.dev);
    this.sink.capture(id, event, { ...props, ...this.options.common, $process_person_profile: false });
  }
}

/** How this copy of OMFV was installed. */
export function installType(): string {
  if (!app.isPackaged) return 'checkout';
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'appimage' : 'pacman';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

const KEY = /^phc_\w+$/;

/**
 * The PostHog project's public key (`phc_…`), which can only send events. A release has it as `omfvPosthogKey` in its
 * package.json, from the release workflow. A dev build takes it from OMFV_POSTHOG_KEY. Null when it isn't there.
 */
export function posthogKey(release: boolean, env: Record<string, string | undefined>, packageJson: () => string): string | null {
  let key: unknown = env.OMFV_POSTHOG_KEY;
  if (release) {
    try {
      key = (JSON.parse(packageJson()) as { omfvPosthogKey?: unknown }).omfvPosthogKey;
    } catch {
      key = null;
    }
  }
  return typeof key === 'string' && KEY.test(key) ? key : null;
}

let shared: Telemetry | null = null;

/** The app's telemetry, made at first use. */
export function telemetry(): Telemetry {
  const release = app.isPackaged ? releaseName(app.getVersion()) : null;
  shared ??= new Telemetry(appSettings(), {
    key: posthogKey(!!release, process.env, () => fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')),
    dev: !release,
    env: process.env,
    common: { build: release ? 'release' : 'dev', release: release ?? 'none', os: process.platform, arch: process.arch, install: installType() },
  });
  return shared;
}

/** Counts `event`. Never throws: telemetry mustn't break anything. */
export function track<E extends TelemetryEvent>(event: E, props?: TelemetryProps<E>): void {
  try {
    telemetry().track(event, props);
  } catch (e) {
    console.warn('[telemetry]', (e as Error).message);
  }
}
