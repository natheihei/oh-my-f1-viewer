/**
 * The host: everything a component, the frame or the agent may use. See docs/DESIGN.md.
 *
 * One read surface (`useLive`, `read`), one write surface (`host.*`), and native primitives. It takes
 * no view on who's calling or whether they should: policy such as spoiler approval belongs to the caller.
 */
import Type from 'typebox';
import type { Channel, SessionInfo } from '../../shared/api';
import { account, agentLink } from '../data/account';
import { catalog, FIRST_SEASON } from '../data/catalog';
import { sessionControl, useSession } from '../data/session';
import { sessionSql } from '../data/sessionData';
import { componentOps } from './components';
import { layoutOps } from './layoutOps';
import { query, write } from './op';
import { suggestionOps } from './suggestions';
import { closeViewingSession, openViewingSession, startCountdown } from './viewing';

export { defineComponent, type ComponentDefinition, type ComponentInfo } from './components';
export { ComponentView, Grid } from './Grid';
export { tilesOf } from './layoutOps';
export { read, useLive, type Live } from './live';
export { useSql, type SqlView } from './useSql';
export type { Op } from './op';
export { PreviewScope, Video } from './Video';
export { MAX_SUGGESTED_STREAMS, type SuggestionsView } from './suggestions';
export type { Countdown } from './viewing';
export type { Service } from '../data/account';
export { FIRST_SEASON, type EventIndex } from '../data/catalog';
export type { ComponentSpec, GroupNode, LayoutState } from '../layout/model';
export type { Dataset, DriverEntry, SessionDataView, StartingGridEntry } from '../../shared/sessionData';

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
    { description: 'Move every stream by some seconds: negative goes back.', args: Type.Object({ seconds: Type.Number() }) },
    ({ seconds }) => sessionControl.seekBy(seconds),
  ),
  seekToDate: write(
    {
      description:
        'Move every stream to a moment on the session data clock, in UTC milliseconds like every date column, kept within the seekable range. ' +
        "Fails when the video can't be matched to the data yet. Returns where it landed on the session clock, and whether it had to stop short.",
      args: Type.Object({ dateMs: Type.Number() }),
    },
    ({ dateMs }): { timeSec: number; clamped: boolean } => sessionControl.seekToDate(dateMs),
  ),
  seekToStart: write({ description: 'Go to the very beginning of the session.' }, () => sessionControl.seekToStart()),
  goLive: write({ description: 'Return to the live edge.' }, () => sessionControl.goLive()),
};

const audio = {
  set: write(
    {
      description: 'Choose which single feed is audible, or null to mute everything.',
      args: Type.Object({ feed: Type.Union([Type.String(), Type.Null()]) }),
    },
    ({ feed }) => sessionControl.setAudio(feed),
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
        'Read the open session with SQL. Tables: car_data, intervals, laps, location, overtakes, pit, position, race_control, stints, weather. ' +
        'Each holds only what the feed had revealed at the frame on screen, unless asOf is "session": then everything the session holds. ' +
        'Times are UTC milliseconds. SELECT only.',
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
  /** What tiles can show. The app registers its components once at start. */
  components: componentOps,
  /** Tiles the agent suggests, which the user adds or dismisses. */
  suggestions: suggestionOps,
  catalog: catalogOps,
  /** Session data that isn't in the live state. Nothing here can change it. */
  data,
  /** Sign-ins, for the user's `/` commands. */
  account,
  /** The link to the agent loop in the main process. */
  agent: agentLink,
};
