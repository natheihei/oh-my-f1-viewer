/**
 * Driver codes without the app around them: the looks, the roster's styles and plain text. The kit
 * and tests import this alone; src/host/drivers.tsx adds the roster and the DOM and React renderers.
 */
import type { DriverEntry } from '../../shared/sessionData';

/**
 * How a code looks.
 * - `bar`: a short bar in the team colour, then the code. The default.
 * - `plain`: the code alone, for where the team colour is drawn already, such as a car's dot or line.
 */
export type CodeVariant = 'bar' | 'plain';

/** The code's colour: ink, dim or mute, or the text it sits in (`inherit`). */
export type CodeTone = 'ink' | 'dim' | 'mute' | 'inherit';

export interface CodeLook {
  /** Defaults to `bar`. */
  variant?: CodeVariant;
  /** Bold: a watched car, or a code that heads what it's in. */
  strong?: boolean;
  /** Defaults to `ink`. */
  tone?: CodeTone;
}

/** The bar's width and the space after it, in pixels, and the code's weights: the same on a canvas and in the DOM. */
export const CODE_BAR = { width: 3, gap: 4 } as const;
export const CODE_WEIGHT = { normal: 500, strong: 700 } as const;

/** Text with drivers in it: a driver a parser recognised is `{ driver }`, drawn as a code. */
export type Part = string | { driver: number };

export interface DriverStyle {
  number: number;
  /** HAM, or the car number when the roster has no code. */
  code: string;
  /** '#rrggbb', from the roster's team colour, or dim without one. */
  colour: string;
  /** The team's second driver in the roster, drawn dashed so teammates tell apart. */
  dashed: boolean;
}

/** The colour of a driver with no team colour: the theme's dim. */
const NO_TEAM = '#8a8a8a';

/** Each driver's code, colour and dash, by car number. */
export function driverStyles(drivers: readonly DriverEntry[]): Map<number, DriverStyle> {
  const teams = new Set<string>();
  const out = new Map<number, DriverStyle>();
  for (const d of drivers) {
    const team = d.team_name ?? d.team_colour;
    const dashed = team != null && teams.has(team);
    if (team != null) teams.add(team);
    const hex = d.team_colour?.replace(/^#/, '');
    out.set(d.driver_number, {
      number: d.driver_number,
      code: d.name_acronym ?? String(d.driver_number),
      colour: hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : NO_TEAM,
      dashed,
    });
  }
  return out;
}

/** A driver's style, or a plain one for a car the roster doesn't have. */
export const styleOf = (styles: Map<number, DriverStyle>, number: number): DriverStyle =>
  styles.get(number) ?? { number, code: String(number), colour: NO_TEAM, dashed: false };

/** The parts as plain text, each driver as its code. */
export function partsText(parts: readonly Part[], code: (number: number) => string): string {
  return parts.map((p) => (typeof p === 'string' ? p : code(p.driver))).join('');
}

/** A tile's label as text: its name, then its drivers' codes. "Gap NOR · PIA". */
export function labelText(name: string, drivers: readonly number[], code: (number: number) => string): string {
  return [name, drivers.map(code).join(' · ')].filter(Boolean).join(' ');
}
