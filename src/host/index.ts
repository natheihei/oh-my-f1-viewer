/**
 * The host: everything a component, the frame or the agent may use. See docs/DESIGN.md.
 *
 * One read surface (`useLive`, `read`), one write surface (`host.*`), and native primitives. It takes
 * no view on who's calling or whether they should: policy such as spoiler approval belongs to the caller.
 */
import Type from 'typebox';
import type { Channel, SessionInfo } from '../../shared/api';
import { account } from '../data/account';
import { appInfo } from '../data/app';
import { savedState } from '../data/savedState';
import { agent } from './agentTurn';
import { catalog, FIRST_SEASON } from '../data/catalog';
import { sessionControl, useSession } from '../data/session';
import { sessionSql } from '../data/sessionData';
import { appearanceOps, backgroundOps } from './backgrounds';
import { buildOps } from './build';
import { componentOps } from './components';
import { healthOps } from './health';
import { layoutOps } from './layoutOps';
import { query, write } from './op';
import { suggestionOps } from './suggestions';
import { closeViewingSession, openViewingSession, startCountdown } from './viewing';
import { telemetryOps } from './telemetry';

export { Backdrop } from './Backdrop';
export {
  defineBackground,
  NO_BACKGROUND,
  type BackgroundDefinition,
  type BackgroundFrame,
  type BackgroundInfo,
  type BackgroundParams,
  type BackgroundView,
} from './backgrounds';
export { defineComponent, fitting, misfit, specOf, type ComponentDefinition, type ComponentInfo, type ComponentOrigin, type Occasion } from './components';
export { ComponentView, Grid, tileTitle } from './Grid';
export {
  CODE_BAR,
  CODE_WEIGHT,
  codeOf,
  DriverCode,
  driverCodeElement,
  driverStyles,
  fillTitle,
  labelText,
  Parts,
  partsText,
  styleOf,
  useDriverStyles,
  type CodeLook,
  type CodeTone,
  type CodeVariant,
  type DriverStyle,
  type Part,
} from './drivers';
export { startPictures } from './picture';
export { startHealth, type Attachment, type ErrorReport, type PlaceHealth } from './health';
export { startMods } from './mods';
export { Displayed, Driver, DriverList, Highlighted, isDriverList, isDriverProp, keyPart } from './props';
export { startBuild, type BuildOffer, type BuildView } from './build';
export { previewScope } from './lookAhead';
export type { BuildChange, ModLogLine, ModStatus } from '../../shared/mods';
export { tilesOf } from './layoutOps';
export { read, useLive, type Live } from './live';
export { useSql, type SqlView } from './useSql';
export { useSqlWindow } from './useSqlWindow';
export type { Op } from './op';
export { PreviewScope, streamSlots, useStream, Video, type Stream } from './Video';
export { useTileHeader, useTilePlace, useTileState, type TileHeader, type TilePlace } from './tile';
export type { SuggestionsView } from './suggestions';
export type { Countdown } from './viewing';
export type { Service } from '../data/account';
export { FIRST_SEASON, type EventIndex } from '../data/catalog';
export type { ChaseAid, Spec } from '../data/spec';
export type { ComponentSpec, LayoutState, Tile } from '../layout/model';
export type { Circuit, CircuitView, Dataset, DriverEntry, SessionDataView } from '../../shared/sessionData';
export type { Channel, SessionInfo, SessionType } from '../../shared/api';

const session = {
  open: write(
    {
      description:
        "Open a session. A replay or live one starts its main feed and replaces whatever is open. One that hasn't started shows a countdown instead, and opens by itself once F1 TV has it live.",
      args: Type.Object({
        contentId: Type.Integer(),
        title: Type.Optional(Type.String()),
        fromStart: Type.Optional(Type.Boolean({ description: 'For a live session: start at the beginning, not the live edge.' })),
      }),
    },
    async ({ contentId, title, fromStart }): Promise<{ session: SessionInfo; feeds: Channel[] | null }> => {
      const info = await catalog.resolve(contentId, title);
      if (info.status === 'upcoming') {
        startCountdown(info, (live) => void openViewingSession(live));
        return { session: info, feeds: null };
      }
      const feeds = await openViewingSession(info, { fromStart });
      return { session: info, feeds };
    },
  ),
  close: write({ description: 'Close the open session and clear the screen.' }, () => closeViewingSession()),
  feeds: query({ description: 'Every feed the open session offers.' }, () => useSession.getState().channels),
};

const playback = {
  play: write({ description: 'Resume every stream.' }, () => sessionControl.play()),
  pause: write({ description: 'Pause every stream.' }, () => sessionControl.pause()),
  toggle: write({ description: 'Play if paused, pause if playing.' }, () => sessionControl.toggle()),
  seek: write(
    { description: 'Move every stream to a time on the session clock.', args: Type.Object({ time: Type.Number() }) },
    ({ time }) => sessionControl.seek(time),
  ),
  seekBy: write(
    {
      description: 'Move every stream by some seconds: negative goes back. Returns where it landed on the session clock, and whether it had to stop short, or null with no session open.',
      args: Type.Object({ seconds: Type.Number() }),
    },
    ({ seconds }): { timeSec: number; clamped: boolean } | null => sessionControl.seekBy(seconds),
  ),
  seekToDate: write(
    {
      description:
        'Move every stream to a moment on the session data clock, in UTC milliseconds like every date column, or to `offsetSec` seconds from it, kept within the seekable range. ' +
        "Fails when the video can't be matched to the data yet. Returns where it landed on the session clock, and whether it had to stop short.",
      args: Type.Object({ dateMs: Type.Number(), offsetSec: Type.Optional(Type.Number()) }),
    },
    ({ dateMs, offsetSec }): { timeSec: number; clamped: boolean } => sessionControl.seekToDate(dateMs, offsetSec),
  ),
  seekToStart: write({ description: 'Go to the very beginning of the session.' }, () => sessionControl.seekToStart()),
  goLive: write({ description: 'Return to the live edge.' }, () => sessionControl.goLive()),
};

const audio = {
  set: write(
    {
      description:
        'Choose the one video that is heard, by its id from live.streams, or null to hear none. A feed shown in two places is two videos, each with its own sound. A preview is never heard.',
      args: Type.Object({ video: Type.Union([Type.String(), Type.Null()]) }),
    },
    ({ video }) => sessionControl.setAudio(video),
  ),
  setVolume: write(
    {
      description: 'Set the master volume, from 0 to 1. The audible feed stays the same.',
      args: Type.Object({ volume: Type.Number({ minimum: 0, maximum: 1 }) }),
    },
    ({ volume }) => sessionControl.setVolume(volume),
  ),
  changeVolumeBy: write(
    { description: 'Raise or lower the master volume: negative lowers it.', args: Type.Object({ amount: Type.Number() }) },
    ({ amount }) => sessionControl.changeVolumeBy(amount),
  ),
  toggleMute: write(
    { description: "Silence the master volume, or restore it. With no audible feed, make the default feed audible." },
    () => sessionControl.toggleMute(),
  ),
};

const catalogOps = {
  loadIndex: write(
    { description: `Load every event from ${FIRST_SEASON} on, or retry a load that failed. Resolves to the index, whether it loaded or not.` },
    () => catalog.loadIndex(),
  ),
  seasons: query({ description: 'The seasons F1 TV has.' }, () => catalog.seasons()),
  events: query(
    { description: 'The Grand Prix events of a season, including future ones.', args: Type.Object({ year: Type.Integer() }) },
    ({ year }) => catalog.events(year),
  ),
  sessions: query(
    { description: 'The sessions of one event, Formula 1 first.', args: Type.Object({ pageId: Type.Integer(), year: Type.Integer() }) },
    ({ pageId, year }) => catalog.sessions(pageId, year),
  ),
  live: query({ description: 'What F1 TV has live right now.' }, () => catalog.live()),
  upcoming: query({ description: "Formula 1 sessions that haven't started, soonest first." }, () => catalog.upcoming()),
};

const data = {
  sql: query(
    {
      description:
        'Read the open session with SQL. Tables: car_data, championship_drivers, championship_teams, drivers, intervals, lap_summary, laps, location, overtakes, pit, pit_lane, position, race_control, session_result, starting_grid, stints, track_status, weather. ' +
        'Each holds only what the feed had revealed at the frame on screen, unless asOf is "session": then everything the session holds. ' +
        'Times are UTC milliseconds. In car_data, a throttle or brake of 104 means the feed has no reading, and drs is empty from 2026. SELECT only.',
      args: Type.Object({
        sql: Type.String(),
        params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()]))),
        asOf: Type.Optional(Type.Union([Type.Literal('playhead'), Type.Literal('session')], { description: 'What is visible: "playhead" (the default) or "session".' })),
      }),
    },
    ({ sql, params, asOf }) => sessionSql(sql, params, asOf),
  ),
};

export const host = {
  session,
  playback,
  audio,
  layout: layoutOps,
  /** What tiles can show. The app registers its components once at start, and mods theirs on each save. */
  components: componentOps,
  /** What can fill the gaps between tiles. The app registers its backgrounds once at start. */
  backgrounds: backgroundOps,
  /** How the app looks: the background in the gaps. */
  appearance: appearanceOps,
  /** Tiles the agent suggests, which the user adds or dismisses. */
  suggestions: suggestionOps,
  /** Build mode's snapshot: begin, then save or undo. */
  build: buildOps,
  /** Whether what's on screen is drawing, and attaching what isn't to the viewer's next message. The report itself is `live.health`. */
  health: healthOps,
  catalog: catalogOps,
  /** Session data that isn't in the live state. Nothing here can change it. */
  data,
  /** Sign-ins, for the user's `/` commands. */
  account,
  /** Which OMFV this is, its release if it is one, and its updates. */
  app: appInfo,
  /** The link to the agent loop in the main process. */
  agent,
  /** Small UI state kept across restarts, in the profile's settings file. The shell restores and saves it. */
  savedState,
  /** Anonymous usage counts, for the shell's notice and `/settings-usage`. Main checks every event before sending it. */
  telemetry: telemetryOps,
};
