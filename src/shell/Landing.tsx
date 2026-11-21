/**
 * The landing page, on the empty screen above the palette: every session as one column of time. A line marks
 * now, with what's coming above it and what's finished below, so scrolling up shows the rest of the season and
 * down the archive. A row clicked writes its session into the palette's input and opens to its suffixes, which
 * add to the prompt in the words the agent takes. Nothing sends until Enter, so it teaches what to type. Only a
 * live session's row starts open. It never says how a session went: the calendar doesn't know.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLive } from '../host';
import { landing, liveSession, useLanding } from './landing';
import { relative, suffixesFor, tapeRows, tapeSessions } from './landingModel';
import { useOnboarding } from './onboardingState';

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const plain = (text: string) => text.replace(/,/g, '');

/** Whether the landing page shows: nothing open or counting down, onboarding over, and a calendar to draw. */
export function useLandingShown(): boolean {
  const onboarding = useOnboarding((s) => s.active);
  const ready = useLive((s) => s.session == null && s.countdown == null && s.schedule.sessions.length > 0);
  return ready && !onboarding;
}

export function Landing() {
  const schedule = useLive((s) => s.schedule);
  const { selected, suffixes } = useLanding();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const sessions = useMemo(() => tapeSessions(schedule), [schedule]);
  const rows = useMemo(() => tapeRows(sessions, now), [sessions, now]);
  const years = useMemo(() => [...new Set(sessions.map((s) => s.year))].sort((a, b) => b - a), [sessions]);
  const tape = useRef<HTMLDivElement | null>(null);

  const scrollTo = (selector: string, lead: number, smooth: boolean) => {
    const box = tape.current;
    const target = box?.querySelector<HTMLElement>(selector);
    if (!box || !target) return;
    box.scrollTo({ top: target.offsetTop - box.clientHeight * lead, behavior: smooth ? 'smooth' : 'auto' });
  };

  // It opens on now, a little above the middle. A live session's row is opened first, so the line lands right.
  const placed = useRef(false);
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (placed.current || sessions.length === 0) return;
    const live = liveSession(sessions, Date.now());
    if (live && !opened.current) {
      opened.current = true;
      landing.expand(live.key);
      return;
    }
    placed.current = true;
    scrollTo('[data-now]', 0.42, false);
  }, [sessions, selected]);

  useEffect(() => {
    if (selected != null && placed.current) tape.current?.querySelector(`[data-key="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  useEffect(() => () => landing.reset(), []);

  return (
    <div className="landing" data-testid="landing" role="region" aria-label="Sessions">
      <div className="landing-edge">
        <span>↑ later this season · ↓ finished · click a session to write it below</span>
        <span className="landing-jump">
          <button type="button" data-testid="landing-jump-now" onClick={() => scrollTo('[data-now]', 0.42, true)}>
            now
          </button>
          {years.map((year) => (
            <button key={year} type="button" onClick={() => scrollTo(`[data-year="${year}"]`, 0, true)}>
              {year}
            </button>
          ))}
        </span>
      </div>
      <div className="landing-tape" ref={tape} data-testid="landing-tape">
        {rows.map((row) => {
          if (row.type === 'year') {
            return (
              <div key={`year-${row.year}`} className="landing-year" data-year={row.year}>
                {row.year}
              </div>
            );
          }
          if (row.type === 'now') {
            return (
              <div key="now" className="landing-now" data-now data-testid="landing-now">
                now · {plain(full.format(now))}
              </div>
            );
          }
          if (row.type === 'meeting') {
            return (
              <div key={`meeting-${row.id}`} className="landing-meeting">
                <span>{row.round != null ? `R${row.round}` : ''}</span>
                <b>{row.name}</b>
                <span>
                  {dayMonth.format(row.startMs)} – {dayMonth.format(row.endMs)}
                </span>
              </div>
            );
          }
          const { session, status, next } = row;
          const open = session.key === selected;
          return (
            <Fragment key={session.key}>
              <button
                type="button"
                className={`landing-row ${open ? 'landing-row-open' : ''}`}
                data-testid="landing-row"
                data-key={session.key}
                data-status={status}
                data-kind={session.kind}
                data-next={next || undefined}
                aria-expanded={open}
                onClick={() => landing.pick(session.key)}
              >
                <span />
                <span>{plain(dayTime.format(session.startMs))}</span>
                <span className="landing-what">{session.label}</span>
                <span className="landing-rel">
                  {next ? 'next · ' : ''}
                  {relative(session, now)}
                </span>
              </button>
              {open ? (
                <div className="landing-chips" data-testid="landing-chips">
                  {suffixesFor(session, now).map((suffix) => {
                    const on = suffixes.includes(suffix.id);
                    return (
                      <button key={suffix.id} type="button" className="landing-chip" data-testid="landing-chip" aria-pressed={on} onClick={() => landing.toggle(suffix.id)}>
                        {on ? '✓' : '+'} {suffix.text}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
