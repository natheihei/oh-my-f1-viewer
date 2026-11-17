/** Reading and writing the timing values charts show. Pure. */

/** A gap is a time, or a number of laps for a lapped car. */
export type Gap = { seconds: number } | { laps: number };

/**
 * `intervals.gap_to_leader` and `interval` hold seconds, or text such as "+1 LAP" for a lapped car,
 * or null (the leader, or nothing yet). Anything unreadable is null, never NaN.
 */
export function parseGap(value: unknown): Gap | null {
  if (typeof value === 'number') return Number.isFinite(value) ? { seconds: value } : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const laps = /^\+?\s*(\d+)\s*LAPS?$/i.exec(text);
  if (laps) return { laps: Number(laps[1]) };
  if (text === '') return null;
  const seconds = Number(text.replace(/^\+/, ''));
  return Number.isFinite(seconds) ? { seconds } : null;
}

/** Seconds, or null for a lapped car or no value. */
export function gapSeconds(value: unknown): number | null {
  const gap = parseGap(value);
  return gap && 'seconds' in gap ? gap.seconds : null;
}

/** "+1.234", "+1 LAP", "+2 LAPS", or "" for none. */
export function formatGap(gap: Gap | null, digits = 3): string {
  if (!gap) return '';
  if ('laps' in gap) return `+${gap.laps} LAP${gap.laps === 1 ? '' : 'S'}`;
  return `+${gap.seconds.toFixed(digits)}`;
}

/** "1:23.456", or "1:23.5" with `digits` 1, or "" for none. */
export function formatLapTime(seconds: number | null | undefined, digits = 3): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const unit = 10 ** digits;
  const ticks = Math.round(seconds * unit);
  const minutes = Math.floor(ticks / (60 * unit));
  const rest = ((ticks % (60 * unit)) / unit).toFixed(digits).padStart(digits ? 3 + digits : 2, '0');
  return minutes ? `${minutes}:${rest}` : rest;
}

/**
 * Laps on a set of tyres: its age when fitted, plus the laps of this stint. A stint's `lap_end` is the
 * last lap it reached, which for the open stint is the lap the car is on.
 */
export function stintAge(lapStart: number, lapEnd: number | null, ageAtStart: number | null): number {
  return (ageAtStart ?? 0) + Math.max(0, (lapEnd ?? lapStart) - lapStart + 1);
}

/** One letter for a compound: S, M, H, I, W, or ? for one the feed didn't name. */
export function compoundLetter(compound: string | null | undefined): string {
  const c = (compound ?? '').toUpperCase();
  return c === 'SOFT' ? 'S' : c === 'MEDIUM' ? 'M' : c === 'HARD' ? 'H' : c.startsWith('INTER') ? 'I' : c === 'WET' ? 'W' : '?';
}

/** A finite number, or null. Row values arrive as `unknown`. */
export const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
