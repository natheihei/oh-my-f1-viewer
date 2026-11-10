/**
 * What varies by season, Grand Prix or session, as data rather than `if` branches (docs/DESIGN.md, rule 5).
 * Defaults sit at the root; each year, meeting and session overrides the level above it.
 */

/** The aid a car gets within a gap of the one ahead: DRS until 2025, Overtake from 2026. */
export interface ChaseAid {
  /** What it's called on screen. */
  label: string;
  /** The gap to the car ahead, in seconds, under which it's available. */
  within: number;
}

export interface Spec {
  chaseAid: ChaseAid;
}

/** A level's overrides: any rule, each in part. */
type Overrides = { [K in keyof Spec]?: Partial<Spec[K]> };

interface Level extends Overrides {
  /** Only for reading the file; the resolver ignores it. */
  name?: string;
}

interface Tree extends Spec {
  years: Record<string, Level & { meetings?: Record<string, Level & { sessions?: Record<string, Level> }> }>;
}

export const SPEC: Tree = {
  chaseAid: { label: 'DRS', within: 1 },
  years: {
    // The 2026 cars have no DRS. Overtake mode takes its place, from within a second at the detection point.
    '2026': { chaseAid: { label: 'OT' } },
  },
};

/** Where a session sits in the tree. Any part can be missing, as when no session is open. */
export interface SpecKey {
  year?: number | null;
  meetingKey?: string | number | null;
  sessionKey?: string | number | null;
}

function merge(base: Spec, over: Overrides | undefined): Spec {
  if (!over) return base;
  return { ...base, chaseAid: { ...base.chaseAid, ...over.chaseAid } };
}

const resolved = new Map<string, Spec>();

/** The spec for one session, the same object each time it's asked for, so it can be selected from live state. */
export function specFor(key: SpecKey | null, tree: Tree = SPEC): Spec {
  const id = `${key?.year ?? ''}/${key?.meetingKey ?? ''}/${key?.sessionKey ?? ''}`;
  const cached = tree === SPEC ? resolved.get(id) : undefined;
  if (cached) return cached;
  const { years, ...defaults } = tree;
  const year = key?.year == null ? undefined : years[key.year];
  const meeting = key?.meetingKey == null ? undefined : year?.meetings?.[key.meetingKey];
  const session = key?.sessionKey == null ? undefined : meeting?.sessions?.[key.sessionKey];
  const spec = [year, meeting, session].reduce<Spec>((acc, level) => merge(acc, level), defaults);
  if (tree === SPEC) resolved.set(id, spec);
  return spec;
}
