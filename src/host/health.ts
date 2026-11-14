/**
 * Whether each place a component shows is drawing: every tile on the grid and every preview in the
 * strip. One that isn't says why: its props don't fit, or it threw. Tiles show it, the agent reads it,
 * and the viewer can attach a tile's error to their next message.
 */
import Type, { type TObject, type TSchema } from 'typebox';
import Value from 'typebox/value';
import { create } from 'zustand';
import { list, notDrawing, problemKey, type ErrorReport, type Moment, type PlaceHealth } from '../../shared/health';
import { modsLink } from '../data/mods';
import { useSession } from '../data/session';
import { useSessionData } from '../data/sessionData';
import { allTiles } from '../layout/model';
import { useLayout } from '../layout/store';
import { componentOf } from './components';
import { useMods } from './mods';
import { query, write } from './op';

export { list, type ErrorReport, type Moment, type PlaceHealth };

/** A tile's error, attached to the viewer's next message. It waits here until that message takes it. */
export interface Attachment {
  /** The tile, from `live.health`. */
  scope: string;
  /** How the tile stood when it was attached. */
  report: ErrorReport;
}

export interface HealthView {
  /** In no particular order. */
  places: PlaceHealth[];
  /** In the order they were attached. */
  attached: Attachment[];
}

export const useHealth = create<HealthView>(() => ({ places: [], attached: [] }));

/** The component code each place last reported with, to tell a report from before a reload. */
const reportedWith = new Map<string, unknown>();

const same = (a: Omit<PlaceHealth, 'since'>, b: Omit<PlaceHealth, 'since'>) =>
  a.where === b.where && a.type === b.type && a.label === b.label && a.state === b.state && a.message === b.message && a.missing.join() === b.missing.join() && a.dropped.join() === b.dropped.join();

const broken = (p: Pick<PlaceHealth, 'state'>) => p.state === 'needs_props' || p.state === 'error';

// A tile that closes goes from what's attached too: the next message would tell the agent of a tile that isn't there.
useLayout.subscribe((layout) => {
  const { attached } = useHealth.getState();
  if (attached.length === 0) return;
  const onScreen = new Set(allTiles(layout).map((t) => t.id));
  if (attached.some((a) => !onScreen.has(a.scope))) useHealth.setState({ attached: attached.filter((a) => onScreen.has(a.scope)) });
});

/** Where the session stands now. Null with no session open. */
function now(): Moment | null {
  const { session, clock } = useSession.getState();
  if (!session) return null;
  const data = useSessionData.getState();
  return { clockSec: clock.timeSec, playheadMs: data.state === 'ready' ? data.playheadMs : null };
}

/** What the places that draw components call: not part of the host's surface. */
export const health = {
  /**
   * `view` is the component code it drew, or tried to. A place that stops drawing is stamped with the
   * moment it did, and keeps that stamp while it fails the same way.
   */
  report(report: Omit<PlaceHealth, 'since'>, view: unknown): void {
    reportedWith.set(report.scope, view);
    const { places } = useHealth.getState();
    const at = places.findIndex((p) => p.scope === report.scope);
    const before = at >= 0 ? places[at] : null;
    if (before && same(before, report)) return;
    const stillSo = before && broken(before) && problemKey(before) === problemKey({ ...report, since: null });
    const place: PlaceHealth = { ...report, since: !broken(report) ? null : stillSo ? before.since : now() };
    useHealth.setState({ places: at >= 0 ? places.map((p, i) => (i === at ? place : p)) : [...places, place] });
  },
  forget(scope: string): void {
    reportedWith.delete(scope);
    const { places } = useHealth.getState();
    if (places.some((p) => p.scope === scope)) useHealth.setState({ places: places.filter((p) => p.scope !== scope) });
  },
};

export interface Fit {
  /** The props to draw with: those the args accept. */
  props: Record<string, unknown>;
  missing: string[];
  dropped: string[];
  /** Set when the props can't be drawn with. */
  message: string | null;
}

/**
 * Fits props to a component's args. Props from before an edit to a mod may not match its new args:
 * those the args still accept are kept, and the rest dropped. It can't draw if a required one is missing.
 */
export function fitProps(args: TObject, props: Record<string, unknown>): Fit {
  if (Value.Check(args, props)) return { props, missing: [], dropped: [], message: null };
  const { properties = {}, required = [] } = args as unknown as { properties?: Record<string, TSchema>; required?: string[] };
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(props)) {
    if (properties[name] && Value.Check(properties[name], value)) kept[name] = value;
    else dropped.push(name);
  }
  const missing = required.filter((name) => !(name in kept));
  if (missing.length) return { props: kept, missing, dropped, message: `Needs ${list(missing)}` };
  if (Value.Check(args, kept)) return { props: kept, missing, dropped, message: null };
  const error = Value.Errors(args, kept)[0];
  return { props: kept, missing, dropped, message: `Its props don't fit: ${error ? `${error.instancePath || '/'} ${error.message}` : 'they do not match its args'}` };
}

/** A tile that isn't drawing, as an agent is told of it. Null for a preview, a tile that draws, or one that's gone. */
function reportOf(scope: string): ErrorReport | null {
  const place = notDrawing(useHealth.getState().places).find((p) => p.scope === scope && p.where === 'tile');
  const tile = place && allTiles(useLayout.getState()).find((t) => t.id === scope);
  if (!place || !tile) return null;
  const isMod = useMods.getState().list.some((m) => m.name === place.type);
  return { place, props: tile.component.props, log: isMod ? `${place.type}/mod.log` : null };
}

const SETTLE_MS = 1000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether every tile has reported with the code its component has now. Previews count only once they're drawn. */
function current(): boolean {
  const { places } = useHealth.getState();
  if (places.some((p) => componentOf(p.type) && reportedWith.get(p.scope) !== componentOf(p.type)?.View)) return false;
  return allTiles(useLayout.getState()).every((t) => !componentOf(t.component.type) || places.some((p) => p.scope === t.id));
}

export const healthOps = {
  settled: query(
    {
      description:
        'The health of every place a component shows, once each has drawn with its latest code, or after a second. For checking a save: a mod that just loaded takes a moment to draw.',
    },
    async (): Promise<PlaceHealth[]> => {
      const deadline = Date.now() + SETTLE_MS;
      // A timer, not a frame: a window nobody can see gets no frames.
      do await wait(50);
      while (!current() && Date.now() < deadline);
      return useHealth.getState().places;
    },
  ),
  errors: query(
    {
      description: "How each of these tiles stands, for those that aren't drawing now, as an agent is told of it: the place, its props, and its mod's log.",
      args: Type.Object({ tiles: Type.Array(Type.String({ description: "A tile's id, from live.health" })) }),
    },
    ({ tiles }): ErrorReport[] => tiles.map(reportOf).filter((r) => r !== null),
  ),
  attach: write(
    {
      description:
        "Attach a tile's error to the viewer's next message: it joins live.attached as the tile stands now, replacing what was attached for it before. Whatever sends that message takes it, busy agent or not. Returns whether it was attached: only a tile that isn't drawing can be.",
      args: Type.Object({ scope: Type.String({ description: "A tile's id, from live.health" }) }),
    },
    ({ scope }): boolean => {
      const report = reportOf(scope);
      if (!report) return false;
      const { attached } = useHealth.getState();
      const at = attached.findIndex((a) => a.scope === scope);
      const next = { scope, report };
      useHealth.setState({ attached: at >= 0 ? attached.map((a, i) => (i === at ? next : a)) : [...attached, next] });
      return true;
    },
  ),
  detach: write(
    {
      description: "Take a tile's error off live.attached, so the next message goes without it. Returns whether it was there.",
      args: Type.Object({ scope: Type.String({ description: "A tile's id, from live.attached" }) }),
    },
    ({ scope }): boolean => {
      const { attached } = useHealth.getState();
      if (!attached.some((a) => a.scope === scope)) return false;
      useHealth.setState({ attached: attached.filter((a) => a.scope !== scope) });
      return true;
    },
  ),
  takeAttached: write(
    { description: 'Take everything on live.attached, to send with a message. Returns it, oldest first, and leaves live.attached empty.' },
    (): Attachment[] => {
      const { attached } = useHealth.getState();
      if (attached.length) useHealth.setState({ attached: [] });
      return attached;
    },
  ),
};

/** Answers the main process when it asks how the screen stands, for the build agent. Call it once, at start. */
export function startHealth(): () => void {
  return modsLink.onHealthAsked((id) => {
    void healthOps.settled().then(
      (places) => modsLink.health(id, places),
      () => modsLink.health(id, null),
    );
  });
}
