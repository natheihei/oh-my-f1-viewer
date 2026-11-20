/**
 * Anonymous usage counts: every event OMFV may send, and every property each may carry. Main sends them
 * (electron/telemetry.ts), and checks each one against this list first, so what isn't here never leaves the
 * machine: an unknown event is dropped, and so is a property that isn't listed or doesn't fit its kind. No
 * kind carries free text. docs/TELEMETRY.md describes the same list for people: change both in the same change.
 */
import type { AgentErrorFix, AgentMode, SessionType, ThinkingLevel } from './api';

/** What a property may hold. Each kind but `id` and `tool` is a closed set, and those two are short names, never text. */
export type PropKind =
  | { enum: readonly string[] }
  | 'boolean'
  /** A whole number from 0, capped at COUNT_CAP. */
  | 'count'
  /** Rounded to the nearest 5, capped at MINUTES_CAP. */
  | 'minutes'
  /** A season, from 2018. */
  | 'year'
  /** A provider's or a model's id, as the app's own list of supported providers names them. */
  | 'id'
  /** An agent tool's snake_case name. */
  | 'tool';

export const COUNT_CAP = 100;
export const MINUTES_CAP = 600;

/** The app's own components, as tiles name their type. A mod's is sent as `mod`. electron/telemetry.test.ts checks it against src/components. */
export const BUILT_IN_TILES = [
  'battle',
  'car_telemetry',
  'chase',
  'gap_evolution',
  'pedal_barcode',
  'pit_window',
  'pit_windows',
  'race_control',
  'race_status',
  'sector_table',
  'speed_ribbon',
  'timing_tower',
  'track_map',
  'tyre_deg',
  'tyre_strategy',
  'video',
] as const;

/** The palette's `/` commands. commands.test.ts checks it against SLASH_COMMANDS. */
export const COMMANDS = [
  '/build',
  '/auto-layout',
  '/settings-background',
  '/settings-agent',
  '/settings-usage',
  '/login-f1tv',
  '/reload-events',
  '/reset-onboarding',
  '/version',
  '/whats-new',
  '/logout-f1tv',
] as const;

const SESSION_TYPES: readonly SessionType[] = ['race', 'qualifying', 'sprint', 'sprint-qualifying', 'practice', 'show', 'other'];
const MODES: readonly AgentMode[] = ['pick', 'view', 'build'];
const THINKING: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const FIXES: readonly (AgentErrorFix | 'none')[] = ['setup', 'connect', 'limit', 'none'];

export const TELEMETRY_EVENTS = {
  /** The first start of a profile with telemetry. `existing_profile`: it was used before, by a release that didn't send. */
  app_installed: { existing_profile: 'boolean' },
  app_started: { f1tv_signed_in: 'boolean', agent_ready: 'boolean', mods: 'count' },
  /** The first start after an update installed: the release it is now is in every event. */
  app_updated: {},
  onboarding_finished: { how: { enum: ['done', 'skipped'] } },
  session_opened: { session_type: { enum: SESSION_TYPES }, live: 'boolean', year: 'year' },
  /** Main adds `minutes`, from the time it was opened: the renderer sends it with nothing. */
  session_closed: { minutes: 'minutes' },
  tile_added: { tile: { enum: [...BUILT_IN_TILES, 'mod'] } },
  command_used: { command: { enum: COMMANDS } },
  agent_connected: { provider: 'id', way: { enum: ['oauth', 'api_key'] } },
  agent_turn: {
    mode: { enum: MODES },
    provider: 'id',
    model: 'id',
    thinking: { enum: THINKING },
    tool_calls: 'count',
    acted: 'boolean',
    outcome: { enum: ['done', 'error', 'cancelled'] },
    fix: { enum: FIXES },
  },
  agent_tool: { mode: { enum: MODES }, tool: 'tool', ok: 'boolean' },
  build_started: {},
  build_ended: { how: { enum: ['save', 'undo'] }, mods: 'count' },
} as const satisfies Record<string, Record<string, PropKind>>;

export type TelemetryEvent = keyof typeof TELEMETRY_EVENTS;

/** The events the renderer may send. The rest only main knows about, so a mod can't send them. */
export const RENDERER_EVENTS = ['onboarding_finished', 'session_opened', 'session_closed', 'tile_added', 'command_used'] as const satisfies readonly TelemetryEvent[];
export type RendererEvent = (typeof RENDERER_EVENTS)[number];

type ValueOf<K> = K extends { enum: readonly (infer E)[] } ? E : K extends 'boolean' ? boolean : K extends 'id' | 'tool' ? string : number;
/** What an event's properties may be, by its list. Every one is optional: one that's unknown is just left out. */
export type TelemetryProps<E extends TelemetryEvent> = { -readonly [P in keyof (typeof TELEMETRY_EVENTS)[E]]?: ValueOf<(typeof TELEMETRY_EVENTS)[E][P]> };

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const TOOL = /^[a-z][a-z0-9_]{0,47}$/;

/** `value` as `kind` allows it, or undefined when it doesn't fit. */
function fit(kind: PropKind, value: unknown): string | number | boolean | undefined {
  if (typeof kind === 'object') return typeof value === 'string' && kind.enum.includes(value) ? value : undefined;
  if (kind === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (kind === 'id') return typeof value === 'string' && ID.test(value) ? value : undefined;
  if (kind === 'tool') return typeof value === 'string' && TOOL.test(value) ? value : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (kind === 'count') return Math.min(Math.round(value), COUNT_CAP);
  if (kind === 'minutes') return Math.min(Math.round(value / 5) * 5, MINUTES_CAP);
  return Number.isInteger(value) && value >= 2018 && value <= 2100 ? value : undefined;
}

/**
 * What of `props` may be sent with `event`, or null when the event isn't on the list. A property that isn't
 * listed, or doesn't fit its kind, is left out.
 */
export function allowedProps(event: string, props: unknown): Record<string, string | number | boolean> | null {
  if (!Object.hasOwn(TELEMETRY_EVENTS, event)) return null;
  const kinds = TELEMETRY_EVENTS[event as TelemetryEvent] as Record<string, PropKind>;
  const given = props && typeof props === 'object' && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, kind] of Object.entries(kinds)) {
    const value = Object.hasOwn(given, key) ? fit(kind, given[key]) : undefined;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Whether telemetry may send, and why not when it can't. Shown by `/settings-usage`. */
export interface TelemetryStatus {
  /** It's on in the settings. */
  enabled: boolean;
  /**
   * Why nothing is sent even so: `environment` is OMFV_TELEMETRY=0 or DO_NOT_TRACK=1, and `no-key` a release
   * built without the PostHog key. Null when it sends, or for a dev build, logs.
   */
  blocked: 'environment' | 'no-key' | null;
  /** The random id this profile's events are counted by. Null while off. */
  id: string | null;
}
