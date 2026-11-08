/** Turns what the user or model calls a stream, such as "Hamilton", "44" or "Noris", into a feed. */
import type { Channel } from '../../shared/api';

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const isInternational = (c: Channel) => normalize(c.label) === 'international';
const CHANNEL_ALIASES: Record<string, (c: Channel) => boolean> = {
  main: (c) => c.kind === 'main',
  'main feed': (c) => c.kind === 'main',
  'main broadcast': (c) => c.kind === 'main',
  broadcast: (c) => c.kind === 'main',
  // The clean international feed, which F1 TV may not mark as its default channel.
  'world feed': isInternational,
  'international feed': isInternational,
  data: (c) => c.kind === 'data',
  'data channel': (c) => c.kind === 'data',
  tracker: (c) => c.kind === 'tracker',
  'driver tracker': (c) => c.kind === 'tracker',
};

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** Misspelled names: the closest driver name within a typo or two, if exactly one is that close. */
function closestDriver(channels: Channel[], needle: string): Channel | undefined {
  if (needle.length < 4) return undefined;
  const allowed = needle.length >= 7 ? 2 : 1;
  const close = channels.filter((c) =>
    normalize(c.driverName ?? '')
      .split(/\s+/)
      .some((name) => name.length >= 4 && editDistance(name, needle) <= allowed),
  );
  return close.length === 1 ? close[0] : undefined;
}

/** Matches a driver code, surname, first name, car number, channel name, or a near miss of a name. */
export function resolveChannel(channels: Channel[], ref: string): Channel | null {
  const needle = normalize(ref);
  if (!needle) return null;
  const alias = CHANNEL_ALIASES[needle];
  if (alias) {
    const hit = channels.find(alias);
    if (hit) return hit;
  }
  return (
    channels.find((c) => normalize(c.label) === needle || normalize(c.title) === needle) ??
    channels.find((c) => c.number != null && String(c.number) === needle) ??
    channels.find((c) => c.driverName && normalize(c.driverName) === needle) ??
    channels.find((c) => c.driverName && normalize(c.driverName).split(/\s+/).includes(needle)) ??
    (needle.length >= 3
      ? channels.find(
          (c) =>
            (c.driverName && normalize(c.driverName).includes(needle)) ||
            normalize(c.label).startsWith(needle) ||
            normalize(c.title).includes(needle),
        )
      : undefined) ??
    closestDriver(channels, needle) ??
    null
  );
}
