/**
 * What's picked on the landing page: a session's row and the suffixes added to it. Picking writes the prompt
 * into the palette's input, where Enter sends it like anything typed. See Landing.tsx and landingModel.ts.
 */
import { create } from 'zustand';
import { read } from '../host';
import { frontSession, promptFor, statusAt, suffixesFor, tapeSessions, toggleSuffix, type TapeSession } from './landingModel';
import { palette } from './palette';

interface LandingState {
  /** The row that's open, by session key. */
  selected: number | null;
  suffixes: string[];
  /** What it last wrote to the input, to tell its own text from the viewer's. */
  written: string;
}

export const useLanding = create<LandingState>(() => ({ selected: null, suffixes: [], written: '' }));

const sessions = (): TapeSession[] => tapeSessions(read().schedule);

function write(session: TapeSession, suffixes: string[]): void {
  const written = promptFor(session, suffixes);
  useLanding.setState({ selected: session.key, suffixes, written });
  palette.draft(written);
}

export const landing = {
  /** Opens a row to show its suffixes, without touching the input: for the live session at start. */
  expand(key: number): void {
    useLanding.setState({ selected: key, suffixes: [], written: '' });
  },
  /** Picks a row: its session goes in the input. Suffixes that still fit the new one are kept. */
  pick(key: number): void {
    const session = sessions().find((s) => s.key === key);
    if (!session) return;
    const fits = suffixesFor(session, Date.now()).map((s) => s.id);
    write(session, useLanding.getState().suffixes.filter((id) => fits.includes(id)));
  },
  /** Adds a suffix to the picked row, or takes it off. */
  toggle(id: string): void {
    const { selected, suffixes } = useLanding.getState();
    const session = sessions().find((s) => s.key === selected);
    if (session) write(session, toggleSuffix(suffixes, id));
  },
  /**
   * The arrow keys in the input: 1 picks the next session later, -1 the one before. Only while the input is
   * empty or still holds what a row wrote, so it never replaces what the viewer typed. Says whether it moved.
   */
  move(direction: 1 | -1, typed: string): boolean {
    const { selected, written } = useLanding.getState();
    if (typed.trim() && typed.trim() !== written) return false;
    const all = sessions();
    const now = Date.now();
    const at = all.findIndex((s) => s.key === selected);
    const to = at < 0 ? frontSession(all, now) : all[at + direction];
    if (!to) return false;
    landing.pick(to.key);
    return true;
  },
  reset(): void {
    useLanding.setState({ selected: null, suffixes: [], written: '' });
  },
};

/** The live session, if there is one: its row starts open. */
export function liveSession(all: TapeSession[], now: number): TapeSession | null {
  return all.find((s) => statusAt(s, now) === 'live') ?? null;
}
