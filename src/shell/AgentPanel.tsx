/**
 * `/settings-agent`: connect the agent's provider and choose its model and thinking level. It takes the
 * palette's place like the background panel. The providers come from main's supported list, and only one
 * is connected at a time: connecting another removes the first once the new one succeeds. API keys are
 * typed into their own window, never here. Esc or × closes it, and cancels a sign-in in progress.
 *
 * Keys: ↑↓ choose a provider, → or Tab go to its settings, where ↑↓ move between them and ←→ change the
 * thinking level, and Tab goes back to the providers.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AgentProviderOption, AiStatus, ConnectWay, ThinkingLevel } from '../../shared/api';
import { host } from '../host';
import { errorText } from './commands';

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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const connectingRef = useRef(connecting);
  connectingRef.current = connecting;

  const load = async () => {
    const [list, now] = await Promise.all([host.agent.providers(), host.agent.status()]);
    setProviders(list);
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

  const choose = async (model: string, thinking: ThinkingLevel) => {
    setError(null);
    try {
      setStatus(await host.agent.choose(model, thinking));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const current = providers.find((p) => p.id === viewed) ?? null;
  const other = providers.find((p) => p.connected && p.id !== viewed) ?? null;
  const model = current?.models.find((m) => m.id === status?.model) ?? null;
  const levels = model?.thinking ?? [];

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const vertical = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const across = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (target.closest('.agent-providers')) {
      if (vertical) {
        e.preventDefault();
        const i = providers.findIndex((p) => p.id === viewed);
        const next = providers[Math.min(providers.length - 1, Math.max(0, i + vertical))];
        if (next) {
          setViewed(next.id);
          focusProvider(next.id);
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

  const settings = () => {
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
          <div className="agent-row">
            <span className="agent-label">Model</span>
            <div className="agent-models" role="listbox" aria-label="Model">
              {current.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  data-control
                  data-testid={`agent-model-${m.id}`}
                  aria-selected={m.id === status?.model}
                  className="agent-model"
                  onClick={() => void choose(m.id, status?.thinking ?? current.recommended.thinking)}
                >
                  <span>{m.name}</span>
                  <span className="agent-model-note">{m.id === current.recommended.model ? 'recommended' : ''}</span>
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
    }
    return (
      <>
        <div>
          {other
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
          {providers.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                data-testid={`agent-provider-${p.id}`}
                aria-pressed={p.id === viewed}
                onClick={() => setViewed(p.id)}
              >
                {p.label}
                {p.connected ? <span className="agent-dot"> ●</span> : null}
              </button>
            </li>
          ))}
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

/** The palette line when the panel closes: the only place the model is named. */
export function describeAgent(status: AiStatus): string | null {
  if (!status.ready || !status.modelName) return null;
  const thinking = status.thinking && status.thinking !== 'off' ? `${status.thinking} thinking` : 'no thinking';
  return `Agent: ${status.modelName}, ${thinking}.`;
}
