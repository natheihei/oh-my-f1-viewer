/**
 * Onboarding, on the empty screen above the palette: sign in to F1 TV, then connect the agent's model. The steps
 * are numbered, and an accordion: the open one says why it's needed and has its button, and the picture beside
 * it shows what it unlocks, at one height for both so the card doesn't move. It opens on the first step not
 * done, and moves on when one finishes. Each button does what a `/` command does, and names it. When the second
 * finishes the card goes and the landing page takes its place, with sessions to pick. See onboardingState.ts
 * for when it shows.
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentProviderOption, AiStatus } from '../../shared/api';
import { host, useLive } from '../host';
import { errorText, reportReadiness } from './commands';
import { OmfvMark } from './OmfvMark';
import { onboarding } from './onboardingState';
import { palette } from './palette';

type StepId = 'f1tv' | 'agent';
type Mark = 'todo' | 'busy' | 'done' | 'error';

interface Action {
  label: string;
  run: () => void;
  /** Drawn filled: the one thing to press. */
  main?: boolean;
  /** Shown but not pressable, to say what the step is waiting on. */
  disabled?: boolean;
}

interface StepView {
  mark: Mark;
  /** Beside the title while the step is closed. */
  status: string;
  /** Under the reason, while it's open: what's happening, or what went wrong. */
  message?: string;
  /** A code to type in on another page, set apart so it's easy to read off. */
  code?: string;
  actions: Action[];
  command?: string;
}

const STEPS: StepId[] = ['f1tv', 'agent'];

const TITLES: Record<StepId, string> = { f1tv: 'Sign in to F1 TV', agent: 'Connect a model' };

const WHY: Record<StepId, string> = {
  f1tv: 'Every feed and all the timing come from your F1 TV subscription. OMFV keeps the sign-in on this computer only.',
  agent: 'You tell the agent what to watch. It opens the session and suggests tiles. OMFV can use the model or subscription you already have.',
};

interface Connecting {
  message: string;
  code?: string;
}

export function Onboarding() {
  const events = useLive((s) => s.events);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [agent, setAgent] = useState<AiStatus | null>(null);
  const [providers, setProviders] = useState<AgentProviderOption[]>([]);
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [copied, setCopied] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [open, setOpen] = useState<StepId | null>(null);

  const refresh = async () => {
    const [status, list] = await Promise.all([host.account.status(), host.agent.providers().catch(() => [])]);
    setSignedIn(status.f1tv.signedIn);
    setAgent(status.agent);
    setProviders(list);
  };
  useEffect(() => {
    void refresh();
  }, []);

  // Signed in, the events load: the agent needs them, and nothing else loads them while onboarding shows.
  useEffect(() => {
    if (signedIn && events.state === 'idle') void host.catalog.loadIndex();
  }, [signedIn, events.state]);

  useEffect(
    () =>
      host.agent.onConnect((event) => {
        setConnecting((c) => {
          if (c == null) return c;
          if (event.type === 'device_code') {
            const site = (() => {
              try {
                return new URL(event.url).host;
              } catch {
                return event.url;
              }
            })();
            return { message: `Your browser opened ${site}. Enter this code there:`, code: event.code };
          }
          return { message: event.message };
        });
      }),
    [],
  );

  const signIn = async () => {
    setSigning(true);
    setSignError(null);
    try {
      await host.account.login('f1tv');
      await host.catalog.loadIndex();
    } catch (e) {
      setSignError(errorText(e));
    } finally {
      setSigning(false);
      await refresh();
    }
  };

  const connect = async (provider: AgentProviderOption) => {
    const way = provider.ways[0];
    if (!way) return;
    setConnecting({ message: way.way === 'oauth' ? 'Finish in your browser.' : 'Paste your key in the window that opened.' });
    setCopied(false);
    setAgentError(null);
    try {
      await host.agent.connect(provider.id, way.way);
    } catch (e) {
      const message = errorText(e);
      if (!/cancelled/i.test(message)) setAgentError(`Couldn't connect ${provider.label}: ${message}`);
    } finally {
      setConnecting(null);
      await refresh();
    }
  };

  const copy = (code: string) => {
    void navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  // The agent's settings, for any other provider or way, or to change the model.
  const settings = () => palette.openPanel('agent', () => void refresh());

  const f1Done = signedIn === true && events.state === 'ready';
  const agentDone = agent?.ready === true;
  const eventCount = events.seasons.reduce((n, s) => n + s.events.length, 0);

  const allDone = f1Done && agentDone;
  const done = () => {
    onboarding.finish('done');
    palette.push('system', "You're set. Pick a session above, or name one here.");
  };

  // A step that finishes hands on to the next one not done, even if it was opened by hand. The last one to
  // finish ends onboarding. Brought back with both already done, it stays until its button is pressed.
  const was = useRef({ f1Done, agentDone });
  useEffect(() => {
    const finished = (f1Done && !was.current.f1Done) || (agentDone && !was.current.agentDone);
    was.current = { f1Done, agentDone };
    if (!finished) return;
    if (allDone) done();
    else setOpen(null);
  }, [f1Done, agentDone]);

  const f1View = (): StepView => {
    if (signing) {
      return {
        mark: 'busy',
        status: 'Waiting for F1 TV…',
        message: 'Finish signing in to F1 TV in the window that opened.',
        actions: [{ label: 'Waiting for F1 TV…', run: () => {}, disabled: true }],
      };
    }
    if (signedIn === null) return { mark: 'todo', status: '', actions: [] };
    if (!signedIn) {
      if (signError) return { mark: 'error', status: 'Sign-in failed', message: signError, actions: [{ label: 'Try again', run: () => void signIn(), main: true }], command: '/login-f1tv' };
      return { mark: 'todo', status: 'Not signed in', actions: [{ label: 'Sign in to F1 TV', run: () => void signIn(), main: true }], command: '/login-f1tv' };
    }
    if (events.state === 'error') {
      return {
        mark: 'error',
        status: "Events didn't load",
        message: `Signed in, but F1 TV's events didn't load: ${events.error ?? 'unknown error'}.`,
        actions: [{ label: 'Retry', run: () => void host.catalog.loadIndex(), main: true }],
        command: '/reload-events',
      };
    }
    if (events.state !== 'ready') return { mark: 'busy', status: 'Loading events…', message: "Signed in. Loading F1 TV's events…", actions: [] };
    return { mark: 'done', status: `Signed in · ${eventCount} events`, message: `Signed in. ${eventCount} events loaded.`, actions: [] };
  };

  const agentView = (): StepView => {
    if (connecting) {
      const cancel: Action = { label: 'Cancel', run: () => void host.agent.cancelConnect() };
      if (connecting.code) {
        const code = connecting.code;
        return { mark: 'busy', status: 'Connecting…', message: connecting.message, code, actions: [{ label: copied ? 'Copied' : 'Copy code', run: () => copy(code), main: true }, cancel] };
      }
      return { mark: 'busy', status: 'Connecting…', message: connecting.message, actions: [cancel] };
    }
    if (agent?.ready) {
      const thinking = agent.thinking && agent.thinking !== 'off' ? `, ${agent.thinking} thinking` : '';
      return { mark: 'done', status: agent.modelName ?? 'Connected', message: `Connected: ${agent.modelName ?? agent.model}${thinking}.`, actions: [{ label: 'Change', run: settings }], command: '/settings-agent' };
    }
    const first = providers.find((p) => p.recommended) ?? providers[0];
    const actions: Action[] = [
      ...(first?.ways[0] ? [{ label: first.ways[0].label, run: () => void connect(first), main: true }] : []),
      { label: 'Other ways to connect', run: settings, main: !first?.ways[0] },
    ];
    return { mark: agentError ? 'error' : 'todo', status: agentError ? "Didn't connect" : 'Not connected', message: agentError ?? undefined, actions, command: '/settings-agent' };
  };

  const views: Record<StepId, StepView> = { f1tv: f1View(), agent: agentView() };
  const shown: StepId = open ?? (!f1Done ? 'f1tv' : 'agent');

  return (
    <div className="onboarding" data-testid="onboarding" role="region" aria-label="Get started">
      <div className="onboarding-head">
        <OmfvMark className="onboarding-logo" />
        <span className="onboarding-title">Get started</span>
        <span className="onboarding-sub">Two steps, about a minute</span>
        {allDone ? (
          <button type="button" className="onboarding-skip" data-testid="onboarding-done" onClick={done}>
            Pick a session
          </button>
        ) : (
          <button type="button" className="onboarding-skip" data-testid="onboarding-skip" onClick={() => {
              onboarding.finish('skipped');
              // What's still missing now comes as fixes in the palette.
              void reportReadiness();
            }}>
            Skip for now
          </button>
        )}
      </div>
      <div className="onboarding-steps">
        {STEPS.map((id, index) => {
          const view = views[id];
          const isOpen = id === shown;
          return (
            <div key={id} className={`onboarding-step ${isOpen ? 'onboarding-step-open' : ''}`} data-testid={`onboarding-step-${id}`} data-mark={view.mark}>
              <button type="button" className="onboarding-step-head" aria-expanded={isOpen} onClick={() => setOpen(id)}>
                <span className={`onboarding-mark onboarding-mark-${view.mark}`} role="img" aria-label={MARK_LABELS[view.mark]}>
                  {view.mark === 'done' ? '✓' : view.mark === 'error' ? '!' : index + 1}
                </span>
                <span>{TITLES[id]}</span>
                {!isOpen ? <span className={`onboarding-status ${view.mark === 'error' ? 'onboarding-error' : ''}`}>{view.status}</span> : null}
              </button>
              {isOpen ? (
                <div className="onboarding-step-body">
                  {view.mark !== 'done' && !view.code ? <p className="onboarding-why">{WHY[id]}</p> : null}
                  {view.message ? <p className={view.mark === 'error' ? 'onboarding-error' : 'onboarding-message'}>{view.message}</p> : null}
                  {view.code ? (
                    <div className="onboarding-code" data-testid="onboarding-code">
                      {view.code}
                    </div>
                  ) : null}
                  {view.actions.length ? (
                    <div className="onboarding-actions">
                      {view.actions.map((action) => (
                        <button
                          key={action.label}
                          type="button"
                          className={`onboarding-action ${action.main ? 'onboarding-action-main' : ''}`}
                          data-testid={`onboarding-action-${id}`}
                          disabled={action.disabled}
                          onClick={action.run}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {view.command ? (
                    <span className="onboarding-command">
                      or type <kbd>{view.command}</kbd> in the palette
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="onboarding-media" aria-hidden="true">
        <Preview step={shown} />
      </div>
    </div>
  );
}

const MARK_LABELS: Record<Mark, string> = { todo: 'to do', busy: 'in progress', done: 'done', error: 'needs attention' };

/** Bars for a timing tower's rows: no names or times, just its shape. */
const TOWER = [92, 84, 78, 70, 66, 58, 52, 47];

function Tower({ rows, gaps }: { rows: number; gaps: boolean }) {
  return (
    <div className="onboarding-preview-tower">
      {TOWER.slice(0, rows).map((width, i) => (
        <div key={i}>
          <span>{i + 1}</span>
          <i style={{ width: `${width}%` }} />
          <i className="onboarding-preview-gap" style={{ width: gaps ? `${i * 12}%` : 0 }} />
        </div>
      ))}
    </div>
  );
}

/** What a step unlocks, drawn small: tiles for F1 TV, a conversation for the agent. */
function Preview({ step }: { step: StepId }) {
  if (step === 'f1tv') {
    return (
      <div className="onboarding-preview">
        <span className="onboarding-preview-label">Unlocks · feeds and timing</span>
        <div className="onboarding-preview-tiles">
          <div className="onboarding-preview-tile onboarding-preview-big">
            <div className="onboarding-preview-bar">World feed</div>
            <div className="onboarding-preview-video" />
          </div>
          <div className="onboarding-preview-tile">
            <div className="onboarding-preview-bar">Timing</div>
            <Tower rows={6} gaps />
          </div>
          <div className="onboarding-preview-tile">
            <div className="onboarding-preview-bar">Gap · 1 to 2</div>
            <svg className="onboarding-preview-chart" viewBox="0 0 120 60" preserveAspectRatio="none">
              <line x1="0" y1="30" x2="120" y2="30" />
              <polyline points="0,40 12,38 24,33 36,35 48,28 60,24 72,26 84,20 96,22 108,16 120,14" />
            </svg>
          </div>
        </div>
        <span>Every feed F1 TV has, in step with its timing.</span>
      </div>
    );
  }
  return (
    <div className="onboarding-preview">
      <span className="onboarding-preview-label">Unlocks · the agent</span>
      <div className="onboarding-preview-chat">
        <div className="palette-line palette-user">
          <span className="palette-mark">&gt;</span>
          <span className="palette-text">2025 Mexico race</span>
        </div>
        <div className="palette-line palette-agent">
          <span className="palette-mark" />
          <span className="palette-text">Opened the race at the start, with the world feed.</span>
        </div>
        <div className="palette-line palette-user">
          <span className="palette-mark">&gt;</span>
          <span className="palette-text">add the gap between the top two</span>
        </div>
        <div className="palette-line palette-agent">
          <span className="palette-mark" />
          <span className="palette-text">Suggested a gap chart beside the feed.</span>
        </div>
        <div className="palette-line palette-user onboarding-preview-build">
          <span className="palette-mark">&gt;</span>
          <span className="palette-text">
            <b>/build</b> a strip of each driver's tyre age
          </span>
        </div>
        <div className="palette-line palette-agent">
          <span className="palette-mark" />
          <span className="palette-text">Built a tyre-age strip, and showed it on a tile under the tower.</span>
        </div>
      </div>
      <span>It keeps to where you are in the session, and asks before it looks further. In build mode it makes new charts for you.</span>
    </div>
  );
}
