/**
 * Onboarding, on the empty screen above the palette: sign in to F1 TV, connect the agent's model, then open a
 * session. The steps are an accordion: the open one says why it's needed and has its button, and the picture
 * beside it shows what it unlocks. It opens on the first step not done. Each button does what a `/` command
 * does, and names it. See onboardingState.ts for when it shows.
 */
import { useEffect, useState } from 'react';
import type { AgentProviderOption, AiStatus } from '../../shared/api';
import { host, useLive } from '../host';
import { sendToAgent } from './agentFeed';
import { errorText, reportReadiness } from './commands';
import { onboarding } from './onboardingState';
import { palette } from './palette';

type StepId = 'f1tv' | 'agent' | 'watch';
type Mark = 'todo' | 'busy' | 'done' | 'error';

interface StepView {
  mark: Mark;
  /** Beside the title while the step is closed. */
  status: string;
  /** Under the reason, while it's open: what's happening, or what went wrong. */
  message?: string;
  /** The buttons; the first is the main one. */
  actions: { label: string; run: () => void }[];
  command?: string;
}

const TITLES: Record<StepId, string> = { f1tv: 'Sign in to F1 TV', agent: 'Connect a model', watch: 'Open a session' };

const WHY: Record<StepId, string> = {
  f1tv: 'Every feed and all the timing come from your F1 TV subscription. f1a keeps the sign-in on this computer only.',
  agent: 'You tell the agent what to watch. It opens the session and suggests tiles. No new subscription: it runs on a model you already have.',
  watch: 'Name any session in the palette, in your own words. The agent finds it and opens the feeds.',
};

const EXAMPLES = ['2025 Mexico race', 'last qualifying'];

export function Onboarding() {
  const events = useLive((s) => s.events);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [agent, setAgent] = useState<AiStatus | null>(null);
  const [providers, setProviders] = useState<AgentProviderOption[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
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
        setConnecting((c) => (c == null ? c : event.type === 'device_code' ? `Enter ${event.code} at ${event.url}` : event.message));
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
    setConnecting(way.way === 'oauth' ? 'Finish signing in in your browser.' : 'Paste your key in the window that opened.');
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

  // The agent's settings, for any other provider or way, or to change the model.
  const settings = () => palette.openPanel('agent', () => void refresh());

  const f1Done = signedIn === true && events.state === 'ready';
  const agentDone = agent?.ready === true;
  const eventCount = events.seasons.reduce((n, s) => n + s.events.length, 0);

  const f1View = (): StepView => {
    if (signing) return { mark: 'busy', status: 'Signing in…', message: 'Finish signing in in the window that opened.', actions: [] };
    if (signedIn === null) return { mark: 'todo', status: '', actions: [] };
    if (!signedIn) {
      if (signError) return { mark: 'error', status: 'Sign-in failed', message: signError, actions: [{ label: 'Try again', run: () => void signIn() }], command: '/login-f1tv' };
      return { mark: 'todo', status: 'Not signed in', actions: [{ label: 'Sign in', run: () => void signIn() }], command: '/login-f1tv' };
    }
    if (events.state === 'error') {
      return {
        mark: 'error',
        status: "Events didn't load",
        message: `Signed in, but F1 TV's events didn't load: ${events.error ?? 'unknown error'}.`,
        actions: [{ label: 'Retry', run: () => void host.catalog.loadIndex() }],
        command: '/reload-events',
      };
    }
    if (events.state !== 'ready') return { mark: 'busy', status: 'Loading events…', message: "Signed in. Loading F1 TV's events…", actions: [] };
    return { mark: 'done', status: `Signed in · ${eventCount} events`, message: `Signed in. ${eventCount} events loaded.`, actions: [] };
  };

  const agentView = (): StepView => {
    if (connecting) return { mark: 'busy', status: 'Connecting…', message: connecting, actions: [{ label: 'Cancel', run: () => void host.agent.cancelConnect() }] };
    if (agent?.ready) {
      const thinking = agent.thinking && agent.thinking !== 'off' ? `, ${agent.thinking} thinking` : '';
      return { mark: 'done', status: agent.modelName ?? 'Connected', message: `Connected: ${agent.modelName ?? agent.model}${thinking}.`, actions: [{ label: 'Change', run: settings }], command: '/settings-agent' };
    }
    const first = providers[0];
    const actions = [
      ...(first?.ways[0] ? [{ label: first.ways[0].label, run: () => void connect(first) }] : []),
      { label: 'Other providers', run: settings },
    ];
    return { mark: agentError ? 'error' : 'todo', status: agentError ? "Didn't connect" : 'Not connected', message: agentError ?? undefined, actions, command: '/settings-agent' };
  };

  const locked = !(f1Done && agentDone);
  const watchView = (): StepView =>
    locked
      ? { mark: 'todo', status: 'After the first two', message: 'Sign in to F1 TV and connect a model first.', actions: [] }
      : { mark: 'todo', status: 'Last step', actions: EXAMPLES.map((text) => ({ label: text, run: () => void sendToAgent(text) })) };

  const views: Record<StepId, StepView> = { f1tv: f1View(), agent: agentView(), watch: watchView() };
  const doneCount = (f1Done ? 1 : 0) + (agentDone ? 1 : 0);
  const shown: StepId = open ?? (!f1Done ? 'f1tv' : !agentDone ? 'agent' : 'watch');

  return (
    <div className="onboarding" data-testid="onboarding" role="region" aria-label="Get started">
      <div className="onboarding-head">
        <span className="onboarding-title">Get started with f1a</span>
        <span className="onboarding-progress" aria-label={`${doneCount} of 3 done`}>
          {(['f1tv', 'agent', 'watch'] as const).map((id) => (
            <i key={id} className={views[id].mark === 'done' ? 'onboarding-progress-done' : ''} />
          ))}
          <span>{doneCount}/3</span>
        </span>
        <button type="button" className="onboarding-skip" data-testid="onboarding-skip" onClick={() => {
            onboarding.finish('skipped');
            // What's still missing now comes as fixes in the palette.
            void reportReadiness();
          }}>
          Skip for now
        </button>
      </div>
      <div className="onboarding-steps">
        {(['f1tv', 'agent', 'watch'] as const).map((id) => {
          const view = views[id];
          const isOpen = id === shown;
          const dim = id === 'watch' && locked;
          return (
            <div key={id} className={`onboarding-step ${isOpen ? 'onboarding-step-open' : ''}`} data-testid={`onboarding-step-${id}`} data-mark={view.mark}>
              <button type="button" className="onboarding-step-head" aria-expanded={isOpen} onClick={() => setOpen(id)}>
                <span className={`onboarding-mark onboarding-mark-${view.mark}`} />
                <span className={dim ? 'onboarding-dim' : ''}>{TITLES[id]}</span>
                {!isOpen ? <span className={`onboarding-status ${view.mark === 'error' ? 'onboarding-error' : ''}`}>{view.status}</span> : null}
              </button>
              {isOpen ? (
                <div className="onboarding-step-body">
                  {view.mark !== 'done' ? <p className="onboarding-why">{WHY[id]}</p> : null}
                  {view.message ? <p className={view.mark === 'error' ? 'onboarding-error' : 'onboarding-message'}>{view.message}</p> : null}
                  {view.actions.length ? (
                    <div className="onboarding-actions">
                      {view.actions.map((action, i) => (
                        <button
                          key={action.label}
                          type="button"
                          className={`onboarding-action ${i === 0 && view.mark !== 'done' ? 'onboarding-action-main' : ''}`}
                          data-testid={`onboarding-action-${id}`}
                          onClick={action.run}
                        >
                          {action.label}
                        </button>
                      ))}
                      {view.command ? (
                        <span className="onboarding-command">
                          or run <kbd>{view.command}</kbd>
                        </span>
                      ) : id === 'watch' ? (
                        <span className="onboarding-command">or type one in the palette</span>
                      ) : null}
                    </div>
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

/** What a step unlocks, drawn small: tiles for F1 TV, a conversation for the agent, examples for the last. */
function Preview({ step }: { step: StepId }) {
  if (step === 'f1tv') {
    return (
      <div className="onboarding-preview">
        <span className="onboarding-preview-label">Unlocks: feeds and timing</span>
        <div className="onboarding-preview-tiles">
          <div className="onboarding-preview-tile onboarding-preview-big">
            <div className="onboarding-preview-bar">World feed</div>
            <div className="onboarding-preview-video" />
          </div>
          <div className="onboarding-preview-tile">
            <div className="onboarding-preview-bar">Timing</div>
            <div className="onboarding-preview-tower">
              {['1 ———', '2 ———', '3 ———', '4 ———', '5 ———'].map((row) => (
                <span key={row}>{row}</span>
              ))}
            </div>
          </div>
          <div className="onboarding-preview-tile">
            <div className="onboarding-preview-bar">Onboard</div>
            <div className="onboarding-preview-video" />
          </div>
        </div>
      </div>
    );
  }
  if (step === 'agent') {
    return (
      <div className="onboarding-preview">
        <span className="onboarding-preview-label">Unlocks: the agent</span>
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
        </div>
      </div>
    );
  }
  return (
    <div className="onboarding-preview">
      <span className="onboarding-preview-label">Try</span>
      <div className="onboarding-preview-examples">
        {[...EXAMPLES, '2024 Monaco onboard LEC'].map((text) => (
          <span key={text} className="palette-example">
            {text}
          </span>
        ))}
      </div>
      <span>The agent and the charts keep to where you are in the session. The agent asks before it looks further.</span>
    </div>
  );
}
