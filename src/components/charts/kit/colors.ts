/**
 * Colours for charts. A canvas can't use CSS variables, so the theme's tokens are read once from the
 * page, with the same values as fallbacks. The accent is left out on purpose: inside a chart it would
 * read as a team or a soft tyre. Emphasis is ink and line weight.
 */
import type { DriverEntry } from '../../../host';

const TOKENS = {
  ink: '#e7e7e7',
  dim: '#8a8a8a',
  /** The quietest grey text still reads in: column heads. */
  mute: '#767676',
  faint: '#4a4a4a',
  line: '#2c2c2c',
  /** Rules between rows of a dense table, under `line`. */
  quiet: '#1b1b1b',
  /** A lifted row, like a watched driver's. */
  select: '#1e1e1e',
  soft: '#ff4d4d',
  medium: '#ffd12e',
  hard: '#f0f0f0',
  intermediate: '#3fb54a',
  wet: '#3d8fe0',
  /** Pedals: throttle green as the broadcast has it, brake violet since red is taken. */
  throttle: '#4cd06a',
  brake: '#b98cff',
};

export type Theme = typeof TOKENS;

let theme: Theme | null = null;

/** The theme's colours, from `@theme` in styles.css. */
export function colors(): Theme {
  if (theme) return theme;
  if (typeof document === 'undefined') return TOKENS;
  const style = getComputedStyle(document.documentElement);
  const read = Object.fromEntries(
    Object.entries(TOKENS).map(([name, fallback]) => [name, style.getPropertyValue(`--color-${name}`).trim() || fallback]),
  ) as Theme;
  // Only keep it once the stylesheet has loaded.
  if (style.getPropertyValue('--color-ink').trim()) theme = read;
  return read;
}

/** A compound's colour, or faint for one the feed didn't name. */
export function tyreColour(compound: string | null | undefined): string {
  const c = colors();
  const name = (compound ?? '').toUpperCase();
  if (name === 'SOFT') return c.soft;
  if (name === 'MEDIUM') return c.medium;
  if (name === 'HARD') return c.hard;
  if (name.startsWith('INTER')) return c.intermediate;
  if (name === 'WET') return c.wet;
  return c.faint;
}

export interface DriverStyle {
  number: number;
  /** HAM, or the car number when the roster has no code. */
  code: string;
  /** '#rrggbb', from the roster's team colour, or dim without one. */
  colour: string;
  /** The team's second driver in the roster, drawn dashed so teammates tell apart. */
  dashed: boolean;
}

/** The dash pattern for a team's second driver. */
export const DASH = [4, 3];

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
      colour: hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : TOKENS.dim,
      dashed,
    });
  }
  return out;
}

/** A driver's style, or a plain one for a car the roster doesn't have. */
export const styleOf = (styles: Map<number, DriverStyle>, number: number): DriverStyle =>
  styles.get(number) ?? { number, code: String(number), colour: TOKENS.dim, dashed: false };
