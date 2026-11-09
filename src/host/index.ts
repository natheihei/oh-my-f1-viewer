/**
 * The host: everything a component, the frame or the agent may use. See docs/DESIGN.md.
 *
 * One read surface (`useLive`, `read`), one write surface (`host.*`), and native primitives. It takes
 * no view on who's calling or whether they should: policy such as spoiler approval belongs to the caller.
 */
import Type from 'typebox';
import { account, agentLink } from '../data/account';
import { catalog } from '../data/catalog';
import { sessionControl, useSession } from '../data/session';
import { sessionSql } from '../data/sessionData';
import { layoutOps } from './layoutOps';
import { query, write } from './op';
import { closeViewingSession, openViewingSession, startCountdown } from './viewing';

export { defineComponent, Grid, type ComponentDefinition } from './Grid';
export { tilesOf } from './layoutOps';
export { read, useLive, type Live } from './live';
export { useSql, type SqlView } from './useSql';
export type { Op } from './op';
export { Video } from './Video';
export type { Countdown } from './viewing';
export type { Service } from '../data/account';
export type { GroupNode, LayoutState } from '../layout/model';

const session = {
  open: write(
    {
      description: "Open a replay or live session and start its main feed. Replaces whatever is open. Fails if it hasn't started.",
      args: Type.Object({
        contentId: Type.Integer(),
        title: Type.Optional(Type.String()),
        fromStart: Type.Optional(Type.Boolean({ description: 'For a live session: start at the beginning, not the live edge.' })),
      }),
    },
    async ({ contentId, title, fromStart }) => {
      const info = await catalog.resolve(contentId, title);
      if (info.status === 'upcoming') throw new Error(`${info.title} hasn't started.`);
      const feeds = await openViewingSession(info, { fromStart });
      return { session: info, feeds };
    },
  ),
  close: write({ description: 'Close the open session and clear the screen.' }, () => closeViewingSession()),
  waitFor: write(
    {
      description: 'Show a countdown to an upcoming session that has been listed. It opens by itself once F1 TV has it live.',
      args: Type.Object({ contentId: Type.Integer() }),
    },
    ({ contentId }) => {
      const info = catalog.known(contentId);
      if (!info) throw new Error('Unknown contentId.');
      if (info.status !== 'upcoming') throw new Error(`${info.title} isn't upcoming.`);
      startCountdown(info, (live) => void openViewingSession(live));
    },
  ),
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
        'Each holds only what the feed had revealed at the frame on screen. Times are UTC milliseconds. SELECT only.',
      args: Type.Object({
        sql: Type.String(),
        params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()]))),
      }),
    },
    ({ sql, params }) => sessionSql(sql, params),
  ),
};

export const host = {
  session,
  playback,
  audio,
  layout: layoutOps,
  catalog: catalogOps,
  /** Session data that isn't in the live state. Nothing here can change it. */
  data,
  /** Sign-ins, for the user's `/` commands. */
  account,
  /** The link to the agent loop in the main process. */
  agent: agentLink,
};
