/**
 * Whether each place a component shows is drawing: every tile on the grid and every preview in the
 * strip. One that isn't says why: its props don't fit, or it threw. Tiles show it, and the agent reads it.
 */
import Type, { type TObject, type TSchema } from 'typebox';
import Value from 'typebox/value';
import { create } from 'zustand';
import { list, type PlaceHealth } from '../../shared/health';
import { modsLink } from '../data/mods';
import { allTiles } from '../layout/model';
import { useLayout } from '../layout/store';
import { useBuild } from './build';
import { componentOf } from './components';
import { query, write } from './op';

export { list, type PlaceHealth };

/** The viewer asked the agent to fix a place that isn't drawing. It waits here until something takes it to the agent. */
export interface FixRequest {
  id: string;
  /** The place it's about, from `live.health`. */
  scope: string;
  /** The request in the viewer's words, such as "The Pace tile needs driver." */
  text: string;
}

export interface HealthView {
  /** In no particular order. */
  places: PlaceHealth[];
  /** Oldest first. */
  asked: FixRequest[];
}

export const useHealth = create<HealthView>(() => ({ places: [], asked: [] }));

let requests = 0;

/** The component code each place last reported with, to tell a report from before a reload. */
const reportedWith = new Map<string, unknown>();

const same = (a: PlaceHealth, b: PlaceHealth) =>
  a.where === b.where && a.type === b.type && a.label === b.label && a.state === b.state && a.message === b.message && a.missing.join() === b.missing.join() && a.dropped.join() === b.dropped.join();

/** What the places that draw components call: not part of the host's surface. */
export const health = {
  /** `view` is the component code it drew, or tried to. */
  report(place: PlaceHealth, view: unknown): void {
    reportedWith.set(place.scope, view);
    const { places } = useHealth.getState();
    const at = places.findIndex((p) => p.scope === place.scope);
    if (at >= 0 && same(places[at], place)) return;
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

/** Whether the agent could fix a place: props always, and code only while it's building. */
export function fixable(place: Pick<PlaceHealth, 'state' | 'where'>, building: boolean): boolean {
  if (place.where !== 'tile') return false;
  return place.state === 'needs_props' || (place.state === 'error' && building);
}

/** What the viewer asks the agent, in their own words, for a place that isn't drawing. */
export function fixRequest(place: PlaceHealth): string | null {
  const what = `The ${place.label} tile`;
  if (place.state === 'needs_props') return place.missing.length ? `${what} needs ${list(place.missing)}.` : `${what} has props that don't fit. ${place.message ?? ''}`.trim();
  if (place.state === 'error') return `${what} stopped with an error: ${place.message ?? 'unknown'}. Fix it.`;
  return null;
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
  askFix: write(
    {
      description:
        "Ask the agent to fix a place that isn't drawing, as the viewer. The request joins live.fixRequests, for whatever speaks to the agent to take. Returns whether it was asked: only props can be fixed outside build mode, and a place is asked about once at a time.",
      args: Type.Object({ scope: Type.String({ description: "A place's scope, from live.health" }) }),
    },
    ({ scope }): boolean => {
      const place = useHealth.getState().places.find((p) => p.scope === scope);
      const text = place && fixable(place, useBuild.getState().active) ? fixRequest(place) : null;
      const { asked } = useHealth.getState();
      if (!text || asked.some((r) => r.scope === scope)) return false;
      requests += 1;
      useHealth.setState({ asked: [...asked, { id: `fix-${requests}`, scope, text }] });
      return true;
    },
  ),
  takeFix: write(
    {
      description: 'Take a fix request off live.fixRequests, to send it to the agent. Returns it, or null if something else took it first.',
      args: Type.Object({ id: Type.String({ description: "A request's id, from live.fixRequests" }) }),
    },
    ({ id }): FixRequest | null => {
      const { asked } = useHealth.getState();
      const request = asked.find((r) => r.id === id) ?? null;
      if (request) useHealth.setState({ asked: asked.filter((r) => r.id !== id) });
      return request;
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
