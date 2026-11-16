/** One read surface over the core's stores. A consumer selects what it needs and re-renders only when that changes. */
import { useSyncExternalStore } from 'react';
import type { Channel, CircuitView, ScheduleView, SessionDataView, SessionInfo } from '../../shared/api';
import { useEventIndex, type EventIndex } from '../data/catalog';
import { useSession, type ClockState, type StreamView } from '../data/session';
import { useCircuit, useSchedule, useSessionData } from '../data/sessionData';
import { specFor, type Spec } from '../data/spec';
import type { LayoutState } from '../layout/model';
import { useLayout } from '../layout/store';
import { useBackground, useBackgrounds, type BackgroundInfo, type BackgroundView } from './backgrounds';
import { useAgentTurn } from './agentTurn';
import { useBuild, type BuildView } from './build';
import { useComponents, type ComponentInfo } from './components';
import { useHealth, type Attachment, type PlaceHealth } from './health';
import { useMods } from './mods';
import type { ModStatus } from '../../shared/mods';
import { useSuggestions, type SuggestionsView } from './suggestions';
import { useTileHeaders, type TileHeader } from './tile';
import { useCountdown, type Countdown } from './viewing';

export interface Live {
  session: SessionInfo | null;
  feeds: Channel[];
  /** Every video playing, by its id: a feed shown in two places is two videos. */
  streams: Record<string, StreamView>;
  /** The one video that's audible, by its id, if any. */
  audio: string | null;
  /** Master level from 0 to 1. */
  volume: number;
  clock: ClockState;
  layout: LayoutState;
  /** What each tile's component says its title bar shows, by tile id, where it says. See `useTileHeader`. */
  headers: Record<string, TileHeader>;
  countdown: Countdown | null;
  /** Tiles the agent suggested this turn, waiting in the strip. */
  suggestions: SuggestionsView;
  /** F1 TV's events from the first supported season on, loaded at start. */
  events: EventIndex;
  /** Every meeting and session from 2023 on. Refreshed each time the app starts. */
  schedule: ScheduleView;
  /** The open session's roster and lap count, as they stood at the frame on screen, and what SQL can read. */
  sessionData: SessionDataView;
  /** The open session's circuit: outline, corners and pit loss. It doesn't depend on the playhead. */
  circuit: CircuitView;
  /** Every component a tile can show, without its code: what the agent picks from. */
  components: ComponentInfo[];
  /** What differs by season, Grand Prix or session, for the open one. The defaults when none is open. */
  spec: Spec;
  /** What fills the gaps between tiles, and every style's settings. */
  background: BackgroundView;
  /** Every background the settings panel offers, without its code. */
  backgrounds: BackgroundInfo[];
  /** Every mod in the mods folder: its state, version and error. The ones that loaded are in `components` too. */
  mods: ModStatus[];
  /** Build mode: whether it's on, and which mods it has changed. See docs/BUILD_MODE.md. */
  build: BuildView;
  /** Each place a component shows, a tile or a preview in the strip, and whether it's drawing. */
  health: PlaceHealth[];
  /** Tiles' errors the viewer attached to their next message, from a tile's button, until a message takes them. */
  attached: Attachment[];
  /** Whether the agent is working on a message. One sent now stops that turn and starts another. */
  agentBusy: boolean;
}

export function read(): Live {
  const { session, channels, streams, audioVideoId, volume, clock } = useSession.getState();
  return {
    session,
    feeds: channels,
    streams,
    audio: audioVideoId,
    volume,
    clock,
    layout: useLayout.getState(),
    headers: useTileHeaders.getState().headers,
    countdown: useCountdown.getState().countdown,
    suggestions: useSuggestions.getState(),
    events: useEventIndex.getState(),
    schedule: useSchedule.getState(),
    sessionData: useSessionData.getState(),
    circuit: useCircuit.getState(),
    components: useComponents.getState().list,
    spec: specFor(session),
    background: useBackground.getState(),
    backgrounds: useBackgrounds.getState().list,
    mods: useMods.getState().list,
    build: useBuild.getState(),
    health: useHealth.getState().places,
    attached: useHealth.getState().attached,
    agentBusy: useAgentTurn.getState().busy,
  };
}

function subscribe(onChange: () => void): () => void {
  const stops = [
    useSession.subscribe(onChange),
    useLayout.subscribe(onChange),
    useTileHeaders.subscribe(onChange),
    useCountdown.subscribe(onChange),
    useSuggestions.subscribe(onChange),
    useEventIndex.subscribe(onChange),
    useSchedule.subscribe(onChange),
    useSessionData.subscribe(onChange),
    useCircuit.subscribe(onChange),
    useComponents.subscribe(onChange),
    useBackground.subscribe(onChange),
    useBackgrounds.subscribe(onChange),
    useMods.subscribe(onChange),
    useBuild.subscribe(onChange),
    useHealth.subscribe(onChange),
    useAgentTurn.subscribe(onChange),
  ];
  return () => stops.forEach((stop) => stop());
}

/** Selectors must return a value or an existing reference, not build a new object each call. */
export function useLive<T>(select: (live: Live) => T): T {
  return useSyncExternalStore(subscribe, () => select(read()));
}
