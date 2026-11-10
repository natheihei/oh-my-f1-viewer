/**
 * What fills the gaps between tiles. Backgrounds are mods, like components: the app registers them
 * once at start, and each declares its settings as a schema the settings panel builds its controls
 * from. The host holds which one is showing and every style's settings, and checks each change
 * against the style's schema.
 */
import Type, { type TObject } from 'typebox';
import { create } from 'zustand';
import { write } from './op';

/** The style that draws nothing: plain black between tiles. Always there, without registering. */
export const NO_BACKGROUND = 'off';

export type BackgroundParams = Record<string, number | boolean>;

/** One frame to paint, in CSS pixels: the context is already scaled for the screen. */
export interface BackgroundFrame {
  width: number;
  height: number;
  /** A layout grid cell, so a background can line up with where tiles snap. */
  cell: { w: number; h: number };
  /** Seconds since the background started showing. Always 0 when the system asks for reduced motion. */
  t: number;
  /** The mouse over the window, or null when it's elsewhere. */
  pointer: { x: number; y: number } | null;
}

export interface BackgroundDefinition<P extends BackgroundParams = BackgroundParams, S = unknown, D = unknown> {
  name: string;
  /** Its name in the settings panel, like "Starfield". */
  title: string;
  /**
   * Its settings, each with a `title` and `default`: a number with `minimum`, `maximum`, `step` and
   * an optional `unit` ('%' shows a 0..1 value as a percentage), a boolean, or a union of literals.
   * A setting with `shownWhen` names another setting it only applies while that one is on or above 0.
   */
  params: TObject;
  /** Data from the host, as a hook given the settings. The background is painted again when it changes. */
  useData?: (params: P) => D;
  /** Why it can't draw now, such as no circuit to draw, or null when it can. Shown in the panel. */
  unavailable?: (data: D) => string | null;
  /** Whether it changes from frame to frame with these settings. Otherwise it's drawn only when something changes. */
  animated(params: P): boolean;
  /** Whether it draws differently with the mouse nearby, with these settings, so it's painted again as the mouse moves. */
  followsPointer?(params: P): boolean;
  /** Whatever it keeps between frames, like where its stars are. Made again when the size or settings change. */
  prepare?(size: { width: number; height: number }, params: P): S;
  draw(ctx: CanvasRenderingContext2D, frame: BackgroundFrame, params: P, state: S, data: D): void;
}

/** Declares a background that the settings panel offers. */
export function defineBackground<P extends BackgroundParams, S = undefined, D = undefined>(
  definition: BackgroundDefinition<P, S, D>,
): BackgroundDefinition {
  return definition as unknown as BackgroundDefinition;
}

/** A background without its code: what the settings panel reads. */
export interface BackgroundInfo {
  name: string;
  title: string;
  /** Its settings' schema, as plain JSON. */
  params: Record<string, unknown>;
}

export interface BackgroundView {
  /** The style showing, or `NO_BACKGROUND`. */
  style: string;
  /** Every registered style's settings, defaults filled in, kept when another style is showing. */
  params: Record<string, BackgroundParams>;
  /** Why the style showing draws nothing right now, such as no session open, or null. */
  unavailable: string | null;
}

const definitions = new Map<string, BackgroundDefinition>();

export const useBackgrounds = create<{ list: BackgroundInfo[] }>(() => ({
  list: [],
}));
export const useBackground = create<BackgroundView>(() => ({
  style: NO_BACKGROUND,
  params: {},
  unavailable: null,
}));

interface ParamSchema {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  step?: number;
  anyOf?: Array<{ const?: unknown }>;
}

function propertiesOf(schema: TObject): Record<string, ParamSchema> {
  return (schema as unknown as { properties: Record<string, ParamSchema> }).properties;
}

/** Every setting at its default. */
export function defaultParams(schema: TObject): BackgroundParams {
  return Object.fromEntries(Object.entries(propertiesOf(schema)).map(([key, s]) => [key, s.default as number | boolean]));
}

/**
 * `values` made to fit `schema`: numbers clamped to their range and snapped to their step, values of
 * the wrong kind or for settings that don't exist left out. What's left out keeps its current value.
 */
export function fitParams(schema: TObject, values: Record<string, unknown>): BackgroundParams {
  const out: BackgroundParams = {};
  for (const [key, s] of Object.entries(propertiesOf(schema))) {
    const v = values[key];
    if (s.anyOf) {
      if (s.anyOf.some((option) => option.const === v)) out[key] = v as number | boolean;
    } else if (s.type === 'boolean') {
      if (typeof v === 'boolean') out[key] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      let n = Math.min(s.maximum ?? Infinity, Math.max(s.minimum ?? -Infinity, v));
      if (s.step) n = Number((Math.round((n - (s.minimum ?? 0)) / s.step) * s.step + (s.minimum ?? 0)).toFixed(6));
      out[key] = n;
    }
  }
  return out;
}

export const backgroundOps = {
  register: write(
    {
      description: 'Make backgrounds available to the settings panel. One with a name already registered replaces it.',
      args: Type.Object({
        backgrounds: Type.Unsafe<BackgroundDefinition[]>({
          type: 'array',
          description: 'Definitions from defineBackground',
        }),
      }),
    },
    ({ backgrounds }) => {
      for (const b of backgrounds) definitions.set(b.name, b);
      useBackgrounds.setState({
        list: [...definitions.values()].map((b) => ({
          name: b.name,
          title: b.title,
          params: JSON.parse(JSON.stringify(b.params)),
        })),
      });
      const { params } = useBackground.getState();
      const filled = Object.fromEntries([...definitions.values()].map((b) => [b.name, { ...defaultParams(b.params), ...params[b.name] }]));
      useBackground.setState({ params: filled });
    },
  ),
};

export const appearanceOps = {
  setBackground: write(
    {
      description:
        `Show a background in the gaps between tiles, by a name from live.backgrounds, or "${NO_BACKGROUND}" for none, and change some of its settings. ` +
        "Settings are checked against the style's own: numbers are kept in range, and anything else that doesn't fit is ignored. Each style keeps its settings while another shows.",
      args: Type.Object({
        style: Type.String(),
        params: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.Boolean()]))),
      }),
    },
    ({ style, params }) => {
      if (style === NO_BACKGROUND) {
        useBackground.setState({ style });
        return;
      }
      const definition = definitions.get(style);
      if (!definition) throw new Error(`Unknown background: ${style}`);
      const current = useBackground.getState().params[style] ?? defaultParams(definition.params);
      useBackground.setState((s) => ({
        style,
        params: {
          ...s.params,
          [style]: {
            ...current,
            ...fitParams(definition.params, params ?? {}),
          },
        },
      }));
    },
  ),
};

/** The registered definition of a style, if there is one. */
export const backgroundOf = (name: string): BackgroundDefinition | undefined => definitions.get(name);
