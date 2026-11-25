/**
 * `/settings-agent`: connect the agent's provider and choose its model and thinking level. It takes the
 * palette's place like the background panel. The providers come from main's supported list, and only one
 * is connected at a time: connecting another removes the first once the new one succeeds. API keys are
 * typed into their own window, never here. Esc or × closes it, and cancels a sign-in in progress.
 *
 * Keys: ↑↓ choose a provider, → or Tab go to its settings, where ↑↓ move between them and ←→ change the
 * thinking level, and Tab goes back to the providers.
 *
 * Advanced, last in the list, is for power users: models.json, a file of pi-ai providers (shared/customModels.ts)
 * for a local model on Ollama, LM Studio or llama.cpp, or any OpenAI- or Anthropic-compatible server. It's edited
 * in the viewer's own editor, never here: Advanced opens it and says what's wrong with it, if anything. Each provider in
 * it is listed above Advanced, with its models and thinking levels like a supported one, and is used once one of
 * its models is chosen.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PI_VERSION, customModelsErrorsText, customModelsPrompt } from '../../shared/customModels';
import type { AgentProviderOption, AiStatus, ConnectWay, CustomModelsFile, ThinkingLevel } from '../../shared/api';
import { host } from '../host';
import { errorText } from './commands';

/** The list's id for Advanced, which is the panel's own and no provider's. */
export const ADVANCED = 'advanced';

interface Connecting {
  provider: string;
  message: string;
  code?: string;
}

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<AgentProviderOption[]>([]);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [viewed, setViewed] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the app read from models.json, and which of Advanced's three copies was just made. */
  const [setup, setSetup] = useState<CustomModelsFile | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const connectingRef = useRef(connecting);
  connectingRef.current = connecting;

  const load = async () => {
    const [list, now, custom] = await Promise.all([host.agent.providers(), host.agent.status(), host.agent.customModels()]);
    setProviders(list);
    setSetup(custom);
    setStatus(now);
    setViewed((v) => v ?? now.provider ?? list[0]?.id ?? null);
    return now;
  };

  const focusProvider = (id: string | null) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-testid="agent-provider-${id}"]`)?.focus();
  const controls = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('.agent-settings [data-control]') ?? [])];

  // Opens on the connected provider, or the first.
  useEffect(() => {
    void load()
      .then((now) => requestAnimationFrame(() => focusProvider(now.provider ?? null)))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!rootRef.current?.contains(document.activeElement)) focusProvider(viewed);
  }, [viewed]);

  // models.json is edited outside the app: what's shown follows each save of it.
  useEffect(() => host.agent.onCustomModels(() => void load().catch((e) => setError(errorText(e)))), []);

  useEffect(
    () =>
      host.agent.onConnect((event) => {
        setConnecting((c) => {
          if (!c) return c;
          if (event.type === 'device_code') return { ...c, message: `Enter this code at ${event.url}`, code: event.code };
          return { ...c, message: event.message };
        });
      }),
    [],
  );

  const close = () => {
    if (connectingRef.current) void host.agent.cancelConnect();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const connect = async (provider: AgentProviderOption, way: ConnectWay) => {
    setError(null);
    setConnecting({ provider: provider.id, message: way === 'oauth' ? 'Opening your browser…' : 'Opening the key window…' });
    try {
      await host.agent.connect(provider.id, way);
      await load();
    } catch (e) {
      const message = errorText(e);
      if (!/cancelled/i.test(message)) setError(`Couldn't connect ${provider.label}: ${message}`);
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async () => {
    setError(null);
    await host.agent.disconnect();
    await load();
  };

  const choose = async (model: string, thinking: ThinkingLevel, provider?: string) => {
    setError(null);
    try {
      setStatus(await host.agent.choose(model, thinking, provider));
      if (provider) await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const copy = (what: Copied, text: string) => {
    setError(null);
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(what);
        window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
      },
      () => setError(`The ${what} couldn't be copied.`),
    );
  };

  const openSetup = async (how: 'open' | 'reveal') => {
    setError(null);
    try {
      await (how === 'open' ? host.agent.openCustomModels() : host.agent.revealCustomModels());
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const advanced = viewed === ADVANCED;
  // The providers of models.json are listed under Advanced, where they come from, and set in from it.
  const builtIn = providers.filter((p) => !p.custom);
  const fromFile = providers.filter((p) => p.custom);
  const providerRow = (p: AgentProviderOption) => (
    <li key={p.id} className={p.custom ? 'agent-from-file' : undefined}>
      <button
        type="button"
        data-testid={`agent-provider-${p.id}`}
        aria-pressed={p.id === viewed}
        aria-label={p.custom ? `${p.label}, from models.json` : undefined}
        title={p.custom ? 'From models.json' : undefined}
        onClick={() => setViewed(p.id)}
      >
        {p.label}
        {p.connected || p.custom?.active ? <span className="agent-dot"> ●</span> : null}
      </button>
    </li>
  );
  const current = advanced ? null : (providers.find((p) => p.id === viewed) ?? null);
  const inUse = providers.find((p) => p.connected || p.custom?.active) ?? null;
  const other = inUse && inUse.id !== viewed ? inUse : null;
  const active = !!current && current.id === status?.provider;
  const model = active ? (current?.models.find((m) => m.id === status?.model) ?? null) : null;
  const levels = model?.thinking ?? [];

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const vertical = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const across = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (target.closest('.agent-providers')) {
      if (vertical) {
        e.preventDefault();
        const ids = [...builtIn.map((p) => p.id), ADVANCED, ...fromFile.map((p) => p.id)];
        const i = ids.indexOf(viewed ?? '');
        const next = ids[Math.min(ids.length - 1, Math.max(0, i + vertical))];
        if (next) {
          setViewed(next);
          focusProvider(next);
        }
      } else if (across > 0 || e.key === 'Tab') {
        e.preventDefault();
        controls()[0]?.focus();
      }
      return;
    }
    if (!target.closest('.agent-settings')) return;
    if (vertical) {
      e.preventDefault();
      const all = controls();
      const at = all.findIndex((c) => c === target || c.contains(target));
      all[Math.min(all.length - 1, Math.max(0, at + vertical))]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      focusProvider(viewed);
    } else if (across && target.closest('.agent-thinking') && model && status?.thinking) {
      e.preventDefault();
      const i = levels.indexOf(status.thinking);
      const next = levels[Math.min(levels.length - 1, Math.max(0, i + across))];
      if (next && next !== status.thinking) void choose(model.id, next);
    }
  };

  /** The model list and thinking levels, shared by a connected provider and one from Advanced. */
  const modelRows = (provider: AgentProviderOption) => (
    <>
      <div className="agent-row">
        <span className="agent-label">Model</span>
        <div className="agent-models" role="listbox" aria-label="Model">
          {provider.models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              data-control
              data-testid={`agent-model-${m.id}`}
              aria-selected={active && m.id === status?.model}
              className="agent-model"
              onClick={() =>
                void choose(m.id, (active ? status?.thinking : provider.recommended?.thinking) ?? provider.recommended?.thinking ?? status?.thinking ?? 'medium', provider.custom && !active ? provider.id : undefined)
              }
            >
              <span>{m.name}</span>
              <span className="agent-model-note">{provider.custom ? (m.id === m.name ? '' : m.id) : m.id === provider.recommended?.model ? 'recommended' : ''}</span>
            </button>
          ))}
        </div>
      </div>
      {model && levels.length > 1 ? (
        <div className="agent-row">
          <span className="agent-label">Thinking</span>
          <div className="bg-choices agent-thinking" role="radiogroup" aria-label="Thinking" tabIndex={0} data-control>
            {levels.map((level) => (
              <button
                key={level}
                type="button"
                tabIndex={-1}
                className="bg-toggle"
                role="radio"
                data-testid={`agent-thinking-${level}`}
                aria-checked={level === status?.thinking}
                aria-pressed={level === status?.thinking}
                onClick={() => void choose(model.id, level)}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );

  /**
   * Advanced: what models.json is for, where it is, what's wrong with it, if anything, with a way to copy that,
   * a way to open it, and a prompt to copy for a coding agent to write it.
   */
  const advancedSettings = () => {
    if (!setup) return null;
    const file = splitPath(setup.path);
    return (
      <>
        <div className="bg-note">
          <span className="agent-lead">To use a model of your own, such as a local one on Ollama or LM Studio, add its provider to models.json.</span>{' '}
          OMFV's agent runs on pi, so a provider is written as pi's createProvider() takes one.{' '}
          <button type="button" className="bg-reset agent-link" data-control data-testid="agent-setup-docs" onClick={() => void host.agent.customModelsDocs()}>
            pi {PI_VERSION} documentation
          </button>
        </div>
        <div className="agent-row agent-apart">
          <span className="agent-label">File</span>
          <button
            type="button"
            className="agent-file"
            data-control
            data-testid="agent-setup-path"
            title={`${setup.path}\nClick to copy`}
            aria-label={`Copy the path of models.json: ${setup.path}`}
            onClick={() => copy('path', setup.path)}
          >
            <span className="agent-file-head">{file.head}</span>
            <span className="agent-file-tail">{file.tail}</span>
            {copied === 'path' ? (
              <span className="agent-file-copied" role="status">
                copied
              </span>
            ) : (
              <ClipIcon />
            )}
          </button>
        </div>
        {setup.errors.length ? (
          <>
            <div className="agent-error agent-apart">The file isn't used until these are fixed:</div>
            <ul className="agent-error agent-setup-errors" data-testid="agent-setup-errors">
              {setup.errors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="bg-choices">
              <button
                type="button"
                className="bg-toggle agent-copy"
                data-control
                data-testid="agent-setup-copy-errors"
                title="Copies the list with the file's path, to paste to your agent"
                onClick={() => copy('errors', customModelsErrorsText(setup.path, setup.errors))}
              >
                <ClipIcon />
                <span role="status">{copied === 'errors' ? 'Copied' : 'Copy errors'}</span>
              </button>
            </div>
          </>
        ) : null}
        <div className={setup.errors.length ? 'bg-choices agent-apart' : 'bg-choices'}>
          <button type="button" className="bg-toggle" data-control data-testid="agent-setup-open" onClick={() => void openSetup('open')}>
            {setup.exists ? 'Open models.json' : 'Create models.json'}
          </button>
          <button type="button" className="bg-toggle" data-control data-testid="agent-setup-reveal" onClick={() => void openSetup('reveal')}>
            Show in folder
          </button>
        </div>
        <div className="bg-note agent-apart">
          <span className="agent-lead">Or have your coding agent write it.</span> The prompt tells it where the file, its schema and an example are, and to
          ask you first which model to connect.
        </div>
        <div className="bg-choices">
          <button type="button" className="bg-toggle agent-copy" data-control data-testid="agent-setup-prompt" onClick={() => copy('prompt', customModelsPrompt(setup))}>
            <ClipIcon />
            <span role="status">{copied === 'prompt' ? 'Copied' : 'Copy prompt for your agent'}</span>
          </button>
        </div>
      </>
    );
  };

  /** A provider from Advanced: where it is, its key, and its models. */
  const customSettings = (provider: AgentProviderOption) => {
    const custom = provider.custom!;
    return (
      <>
        <div className="bg-note" data-testid="agent-from-file">
          <span className="agent-lead">Set up by hand, in models.json.</span> Advanced opens it.
        </div>
        <div className="agent-row">
          <span className="agent-label">Server</span>
          <span className="agent-server">{custom.baseUrl}</span>
          <span className="bg-note">{custom.api}</span>
        </div>
        <div className="agent-row">
          <span className="agent-label">API key</span>
          <span>{custom.hasKey ? 'In models.json' : 'None'}</span>
        </div>
        {!active ? (
          <div className="bg-note">
            {other ? `The agent uses ${other.label}. ` : ''}Choose a model to use {provider.label}
            {other && !other.custom ? `. ${other.label} stays connected.` : '.'}
          </div>
        ) : null}
        {modelRows(provider)}
      </>
    );
  };

  const settings = () => {
    if (advanced) return advancedSettings();
    if (!current) return <div className="bg-note">No provider is available.</div>;
    if (connecting) {
      return (
        <>
          <div>{connecting.message}</div>
          {connecting.code ? <div className="agent-code">{connecting.code}</div> : null}
          <div>
            <button type="button" className="bg-toggle" data-control onClick={() => void host.agent.cancelConnect()}>
              Cancel
            </button>
          </div>
        </>
      );
    }
    if (current.custom) return customSettings(current);
    if (current.connected) {
      return (
        <>
          <div className="agent-row">
            <span className="agent-label">Account</span>
            <span>{current.connected.label}</span>
            <button type="button" className="bg-toggle" data-control data-testid="agent-disconnect" onClick={() => void disconnect()}>
              {current.connected.way === 'oauth' ? 'Sign out' : 'Remove'}
            </button>
          </div>
          {modelRows(current)}
        </>
      );
    }
    return (
      <>
        <div>
          {other?.custom
            ? `The agent uses ${other.label}, from Advanced. Connecting ${current.label} switches to it, and models.json stays as it is.`
            : other
              ? `The agent uses ${other.label}. Connecting ${current.label} removes it, and if you cancel, nothing changes.`
              : `Connect ${current.label} to use the agent.`}
        </div>
        {current.ways.map((w) => (
          <div key={w.way} className="agent-way">
            <button
              type="button"
              className="bg-toggle"
              data-control
              data-testid={`agent-connect-${w.way}`}
              onClick={() => void connect(current, w.way)}
            >
              {w.label}
            </button>
            <span className="bg-note">{w.note}</span>
          </div>
        ))}
      </>
    );
  };

  return (
    <div ref={rootRef} className="bg-panel" role="dialog" aria-label="Agent" data-testid="agent-panel" onKeyDown={onKeyDown}>
      <div className="bg-panel-head">
        <span>Agent</span>
        <button type="button" className="tile-close" aria-label="Close agent settings" title="Close" onClick={close}>
          ×
        </button>
      </div>
      <div className="bg-panel-body">
        <ul className="bg-styles agent-providers" aria-label="Provider">
          {builtIn.map((p) => providerRow(p))}
          <li className="agent-advanced">
            <button type="button" data-testid={`agent-provider-${ADVANCED}`} aria-pressed={advanced} onClick={() => setViewed(ADVANCED)}>
              Advanced
            </button>
          </li>
          {fromFile.map((p) => providerRow(p))}
        </ul>
        <div className="bg-settings agent-settings">
          {settings()}
          {error ? <div className="agent-error">{error}</div> : null}
        </div>
      </div>
      <div className="bg-panel-foot">↑↓ choose · → or tab to settings · ←→ thinking · esc close</div>
    </div>
  );
}

/** What Advanced copies by a click, as its failure names it. */
type Copied = 'path' | 'prompt' | 'errors';

/** A path in two parts, so a long one is cut in the middle: its last folder and the file's name always show. */
export function splitPath(file: string): { head: string; tail: string } {
  const cut = file.search(/[\\/][^\\/]+[\\/][^\\/]+$/);
  return cut > 0 ? { head: file.slice(0, cut), tail: file.slice(cut) } : { head: '', tail: file };
}

/** A clipboard, for what's copied by a click. */
function ClipIcon() {
  return (
    <svg viewBox="0 0 12 12" className="agent-file-icon" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="8" stroke="currentColor" fill="none" />
      <path d="M4.5 2.5v-1h3v1" stroke="currentColor" fill="none" />
    </svg>
  );
}

/** The palette line when the panel closes: the only place the model is named. */
export function describeAgent(status: AiStatus): string | null {
  if (!status.ready || !status.modelName) return null;
  const thinking = status.thinking && status.thinking !== 'off' ? `${status.thinking} thinking` : 'no thinking';
  return `Agent: ${status.modelName}, ${thinking}.`;
}
