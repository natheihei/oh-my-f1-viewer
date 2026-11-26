/**
 * `/settings-agent`: connect the agent's provider and choose its model and thinking level. It takes the
 * palette's place like the background panel. Built-in providers come from the installed pi-ai, and only one
 * is connected at a time: connecting another removes the first once the new one succeeds. API keys and other
 * auth prompts are answered in their own sandboxed window, never here. Esc or × closes it, and cancels a
 * sign-in in progress.
 *
 * Advanced, pinned at the bottom of the sidebar, is for power users: models.json, a file of pi-ai providers
 * (shared/customModels.ts) for a local model on Ollama, LM Studio or llama.cpp, or any OpenAI- or
 * Anthropic-compatible server. It's edited in the viewer's own editor, never here: Advanced opens it and says
 * what's wrong with it, if anything. Each provider in it is listed under Advanced, with its models and
 * thinking levels like a built-in one, and is used once one of its models is chosen.
 */
import { useEffect, useRef, useState } from 'react';
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
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrolledProvider = useRef(false);
  const connectingRef = useRef(connecting);
  connectingRef.current = connecting;

  const load = async () => {
    const [list, now, custom] = await Promise.all([host.agent.providers(), host.agent.status(), host.agent.customModels()]);
    setProviders(list);
    setSetup(custom);
    setStatus(now);
    const connected = list.find((p) => p.connected)?.id;
    const recommended = list.find((p) => p.recommended)?.id;
    const initial = now.provider ?? connected ?? recommended ?? list[0]?.id ?? null;
    setViewed((v) => v ?? initial);
    return now;
  };

  const scrollIntoContainer = (el: HTMLElement | null | undefined) => {
    const box = el?.closest<HTMLElement>('.agent-providers, .agent-models');
    if (!el || !box) return;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top - (box.clientHeight - el.clientHeight) / 2;
    box.scrollTop = Math.max(0, box.scrollTop + delta);
  };

  const scrollProviderIntoView = (id: string | null) => {
    if (!id) return;
    scrollIntoContainer(rootRef.current?.querySelector<HTMLElement>(`[data-testid="agent-provider-${CSS.escape(id)}"]`));
  };

  const scrollModelIntoView = (id: string | null | undefined) => {
    if (!id) return;
    scrollIntoContainer(rootRef.current?.querySelector<HTMLElement>(`[data-testid="agent-model-${CSS.escape(id)}"]`));
  };

  // Opens on the active, connected, or recommended provider, scrolled into view in its alphabetical place.
  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (scrolledProvider.current || !providers.length || !viewed) return;
    scrolledProvider.current = true;
    scrollProviderIntoView(viewed);
  }, [providers.length, viewed]);
  useEffect(() => {
    setModelFilter('');
  }, [viewed]);
  useEffect(() => {
    const provider = providers.find((p) => p.id === viewed);
    if (!provider || (!provider.connected && !provider.custom)) return;
    const target = status?.ready && status.provider === provider.id ? status.model : provider.recommended?.model;
    if (!target) return;
    scrollModelIntoView(target);
  }, [viewed, providers, status?.provider, status?.ready]);

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
  const pQuery = providerFilter.trim().toLowerCase();
  const visibleBuiltIn = pQuery
    ? builtIn.filter((p) => p.label.toLowerCase().includes(pQuery) || p.id.toLowerCase().includes(pQuery))
    : builtIn;
  const hasDot = (p: AgentProviderOption) =>
    status?.ready ? p.id === status.provider : !!p.connected;
  const providerRow = (p: AgentProviderOption) => (
    <li key={p.id} className={p.custom ? 'agent-from-file' : undefined}>
      <button
        type="button"
        data-testid={`agent-provider-${p.id}`}
        aria-pressed={p.id === viewed}
        aria-label={p.custom ? `${p.label}, from models.json` : undefined}
        title={p.custom ? 'From models.json' : p.label}
        onClick={() => setViewed(p.id)}
      >
        <span className="agent-provider-name">{p.label}</span>
        {hasDot(p) ? <span className="agent-dot"> ●</span> : null}
      </button>
    </li>
  );
  const current = advanced ? null : (providers.find((p) => p.id === viewed) ?? null);
  const inUse = providers.find((p) => (status?.ready ? p.id === status.provider : !!p.connected)) ?? null;
  const other = inUse && inUse.id !== viewed ? inUse : null;
  const active = !!current && current.id === status?.provider && status?.ready === true;
  const model = active ? (current?.models.find((m) => m.id === status?.model) ?? null) : null;
  const levels = model?.thinking ?? [];

  /** The model list and thinking levels, shared by a connected provider and one from Advanced. */
  const modelRows = (provider: AgentProviderOption) => {
    const showFilter = provider.models.length > 8;
    const mQuery = showFilter ? modelFilter.trim().toLowerCase() : '';
    const visibleModels = mQuery
      ? provider.models.filter((m) => m.name.toLowerCase().includes(mQuery) || m.id.toLowerCase().includes(mQuery))
      : provider.models;
    return (
      <>
        <div className="agent-row">
          <span className="agent-label">Model</span>
          <div className="agent-models-wrap">
            {showFilter ? (
              <div className="agent-filter-row">
                <input
                  type="text"
                  className="agent-filter"
                  data-testid="agent-model-filter"
                  aria-label="Filter models"
                  placeholder={`Filter ${provider.models.length} models…`}
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                />
                {mQuery ? (
                  <span className="agent-filter-count">
                    {visibleModels.length}/{provider.models.length}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="agent-models" role="listbox" aria-label="Model">
              {visibleModels.length ? (
                visibleModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    data-testid={`agent-model-${m.id}`}
                    aria-selected={active && m.id === status?.model}
                    className="agent-model"
                    onClick={() =>
                      void choose(
                        m.id,
                        (active ? status?.thinking : provider.recommended?.thinking) ?? provider.recommended?.thinking ?? status?.thinking ?? 'medium',
                        !active ? provider.id : undefined,
                      )
                    }
                  >
                    <span>{m.name}</span>
                    <span className="agent-model-note">{provider.custom ? (m.id === m.name ? '' : m.id) : m.id === provider.recommended?.model ? 'recommended' : ''}</span>
                  </button>
                ))
              ) : (
                <div className="agent-models-empty">No models match “{modelFilter.trim()}”.</div>
              )}
            </div>
          </div>
        </div>
        {model && levels.length > 1 ? (
          <div className="agent-row">
            <span className="agent-label">Thinking</span>
            <div className="bg-choices agent-thinking" role="radiogroup" aria-label="Thinking">
              {levels.map((level) => (
                <button
                  key={level}
                  type="button"
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
  };

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
          OMFV's agent runs on pi, so each provider follows{' '}
          <button type="button" className="bg-reset agent-link" data-testid="agent-setup-docs" onClick={() => void host.agent.customModelsDocs()}>
            pi {PI_VERSION} documentation
          </button>
          {' '}for createProvider().
        </div>
        <div className="agent-file-row agent-apart">
          <span className="agent-label">File</span>
          <button
            type="button"
            className="agent-file"
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
          <button type="button" className="bg-toggle" data-testid="agent-setup-open" onClick={() => void openSetup('open')}>
            {setup.exists ? 'Open models.json' : 'Create models.json'}
          </button>
          <button type="button" className="bg-toggle" data-testid="agent-setup-reveal" onClick={() => void openSetup('reveal')}>
            Show in folder
          </button>
        </div>
        <div className="bg-note agent-apart">
          <span className="agent-lead">Or have your coding agent write it.</span> The prompt tells it where the file, its schema and an example are, and to
          ask you first which model to connect.
        </div>
        <div className="bg-choices">
          <button type="button" className="bg-toggle agent-copy" data-testid="agent-setup-prompt" onClick={() => copy('prompt', customModelsPrompt(setup))}>
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
            <button type="button" className="bg-toggle" onClick={() => void host.agent.cancelConnect()}>
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
            <button type="button" className="bg-toggle" data-testid="agent-disconnect" onClick={() => void disconnect()}>
              {current.connected.way === 'oauth' ? 'Sign out' : 'Remove'}
            </button>
          </div>
          {!active ? (
            <div className="bg-note">
              {other ? `The agent uses ${other.label}. ` : ''}Choose a model to use {current.label}.
            </div>
          ) : null}
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
    <div ref={rootRef} className="bg-panel" role="dialog" aria-label="Agent" data-testid="agent-panel">
      <div className="bg-panel-head">
        <span>Agent</span>
        <button type="button" className="tile-close" aria-label="Close agent settings" title="Close" onClick={close}>
          ×
        </button>
      </div>
      <div className="bg-panel-body agent-panel-body">
        <div className="bg-styles agent-sidebar">
          {builtIn.length > 8 ? (
            <div className="agent-provider-filter-wrap">
              <input
                type="text"
                className="agent-filter"
                data-testid="agent-provider-filter"
                aria-label="Filter providers"
                placeholder="Filter providers…"
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
              />
            </div>
          ) : null}
          <ul className="agent-providers" aria-label="Provider">
            {visibleBuiltIn.length ? (
              visibleBuiltIn.map((p) => providerRow(p))
            ) : (
              <li className="agent-providers-empty">No providers match</li>
            )}
          </ul>
          <ul className="agent-advanced-list" aria-label="Advanced">
            <li className="agent-advanced">
              <button type="button" data-testid={`agent-provider-${ADVANCED}`} aria-pressed={advanced} onClick={() => setViewed(ADVANCED)}>
                Advanced
              </button>
            </li>
            {fromFile.map((p) => providerRow(p))}
          </ul>
        </div>
        <div className="bg-settings agent-settings">
          {settings()}
          {error ? <div className="agent-error">{error}</div> : null}
        </div>
      </div>
      <div className="bg-panel-foot">esc close</div>
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
