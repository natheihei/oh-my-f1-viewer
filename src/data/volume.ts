/** The rules of the master volume: a level from 0 to 1, where 0 is what mute means. */

/** Dragging down to mute passes through levels too quiet to hear, so unmuting never restores one. */
const MIN_UNMUTED_VOLUME = 0.25;

/** Keeps a level in range, on whole percents so that repeated steps don't drift. */
export function normalizeVolume(volume: number): number {
  return Math.round(Math.max(0, Math.min(1, volume)) * 100) / 100;
}

/** The level to go to from the icon: silent if sound is on, or back to what was last heard. */
export function toggledVolume(volume: number, lastHeard: number): number {
  return volume > 0 ? 0 : Math.max(lastHeard, MIN_UNMUTED_VOLUME);
}
