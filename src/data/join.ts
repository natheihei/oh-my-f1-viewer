/**
 * Where a stream should start. A stream joining a session that is already playing follows the clock.
 * Otherwise a replay starts at its beginning, and a live session at the live edge unless the viewer
 * asked for the start of the broadcast.
 */
export type JoinPoint = 'clock' | 'beginning' | 'live-edge' | 'live-start';

export function joinPoint({ live, fromStart, started }: { live: boolean; fromStart: boolean; started: boolean }): JoinPoint {
  if (started) return 'clock';
  if (!live) return 'beginning';
  return fromStart ? 'live-start' : 'live-edge';
}
