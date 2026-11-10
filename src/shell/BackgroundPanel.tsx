/**
 * `/settings-background`: pick what fills the gaps between tiles, and tune it. It takes the
 * palette's place, so the gaps stay in view, and every change shows and is saved at once. The
 * controls come from each background's settings schema. Esc or × closes it.
 *
 * Keys: ↑↓ choose a style, → or Tab go to its settings, where ↑↓ move between them and ←→ adjust
 * one (Shift for ten steps at a time), and Tab goes back to the styles.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { host, NO_BACKGROUND, read, useLive, type BackgroundInfo } from '../host';

interface Setting {
  type?: string;
  title?: string;
  default?: number | boolean;
  minimum?: number;
  maximum?: number;
  step?: number;
  unit?: string;
  shownWhen?: string;
  anyOf?: Array<{ const: number | boolean }>;
}

const settingsOf = (info: BackgroundInfo) => Object.entries((info.params as { properties?: Record<string, Setting> }).properties ?? {});

/** A value as the panel shows it: '%' turns 0..1 into a percentage, other units follow the number. */
export function formatSetting(s: Setting, v: number | boolean): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (s.unit === '%') return `${Math.round(v * 100)}%`;
  const decimals = s.step && s.step < 1 ? Math.min(3, Math.ceil(-Math.log10(s.step) - 1e-9)) : 0;
  return `${v.toFixed(decimals)}${s.unit ?? ''}`;
}

/** A setting moved one step, or ten with `big`: a number within its range, the next or previous choice, or a switch on or off. */
export function nudge(s: Setting, value: number | boolean, direction: 1 | -1, big = false): number | boolean {
  if (s.type === 'boolean') return direction > 0;
  if (s.anyOf) {
    const options = s.anyOf.map((o) => o.const);
    const i = Math.max(0, options.indexOf(value));
    return options[Math.min(options.length - 1, Math.max(0, i + direction))];
  }
  const step = (s.step ?? ((s.maximum ?? 1) - (s.minimum ?? 0)) / 100) * (big ? 10 : 1);
  return Math.min(s.maximum ?? Infinity, Math.max(s.minimum ?? -Infinity, Number(value) + direction * step));
}

function Control({ style, id, setting, value }: { style: string; id: string; setting: Setting; value: number | boolean }) {
  const set = (v: number | boolean) => host.appearance.setBackground({ style, params: { [id]: v } });
  if (setting.type === 'boolean') {
    return (
      <div>
        <button type="button" className="bg-toggle" data-control aria-pressed={value === true} onClick={() => set(!value)}>
          {value ? 'on' : 'off'}
        </button>
      </div>
    );
  }
  if (setting.anyOf) {
    return (
      <div className="bg-choices" role="radiogroup" tabIndex={0} data-control>
        {setting.anyOf.map(({ const: option }) => (
          <button
            key={String(option)}
            type="button"
            tabIndex={-1}
            className="bg-toggle"
            role="radio"
            aria-checked={value === option}
            aria-pressed={value === option}
            onClick={() => set(option)}
          >
            {String(option)}
          </button>
        ))}
      </div>
    );
  }
  const [min, max] = [setting.minimum ?? 0, setting.maximum ?? 1];
  return (
    <input
      type="range"
      className="bg-slider"
      data-control
      id={`bg-${style}-${id}`}
      min={min}
      max={max}
      step={setting.step ?? 'any'}
      value={Number(value)}
      style={
        {
          '--fill': `${((Number(value) - min) / (max - min || 1)) * 100}%`,
        } as React.CSSProperties
      }
      onChange={(e) => set(Number(e.target.value))}
    />
  );
}

export function BackgroundPanel({ onClose }: { onClose: () => void }) {
  const { style, params, unavailable } = useLive((s) => s.background);
  const list = useLive((s) => s.backgrounds);
  const current = list.find((b) => b.name === style);
  const values = params[style] ?? {};
  const styles = [{ name: NO_BACKGROUND, title: 'Off' }, ...list];
  const rootRef = useRef<HTMLDivElement | null>(null);
  const settings = current ? settingsOf(current).filter(([, s]) => !s.shownWhen || Boolean(values[s.shownWhen])) : [];

  const focusStyle = (name: string) => rootRef.current?.querySelector<HTMLElement>(`[data-testid="background-${name}"]`)?.focus();
  const rows = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('.bg-setting') ?? [])];
  const focusRow = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>('[data-control]')?.focus();

  // Opens on the style showing.
  useEffect(() => {
    focusStyle(read().background.style);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const vertical = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const across = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (target.closest('.bg-styles')) {
      if (vertical) {
        e.preventDefault();
        const i = styles.findIndex((b) => b.name === style);
        const next = styles[Math.min(styles.length - 1, Math.max(0, i + vertical))];
        host.appearance.setBackground({ style: next.name });
        focusStyle(next.name);
      } else if (across > 0 || e.key === 'Tab') {
        e.preventDefault();
        focusRow(rows()[0]);
      }
      return;
    }
    const row = target.closest<HTMLElement>('.bg-setting');
    if (!row) return;
    if (vertical) {
      e.preventDefault();
      const all = rows();
      focusRow(all[all.indexOf(row) + vertical]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      focusStyle(style);
    } else if (across) {
      e.preventDefault();
      const found = settings.find(([id]) => id === row.dataset.setting);
      if (!found) return;
      const [id, s] = found;
      host.appearance.setBackground({
        style,
        params: {
          [id]: nudge(s, values[id] ?? s.default ?? 0, across, e.shiftKey),
        },
      });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div ref={rootRef} className="bg-panel" role="dialog" aria-label="Background" data-testid="background-panel" onKeyDown={onKeyDown}>
      <div className="bg-panel-head">
        <span>Background</span>
        <button type="button" className="tile-close" aria-label="Close background settings" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="bg-panel-body">
        <ul className="bg-styles" aria-label="Style">
          {styles.map((b) => (
            <li key={b.name}>
              <button
                type="button"
                data-testid={`background-${b.name}`}
                aria-pressed={b.name === style}
                onClick={() => host.appearance.setBackground({ style: b.name })}
              >
                {b.title}
              </button>
            </li>
          ))}
        </ul>
        <div className="bg-settings">
          {!current ? <div className="bg-note">Plain black between tiles.</div> : null}
          {current && unavailable ? <div className="bg-note">{unavailable}</div> : null}
          {settings.map(([id, s]) => {
            const value = values[id] ?? s.default ?? 0;
            const changed = s.default !== undefined && value !== s.default;
            return (
              <div key={id} className="bg-setting" data-setting={id}>
                <label htmlFor={`bg-${style}-${id}`}>{s.title ?? id}</label>
                <Control style={style} id={id} setting={s} value={value} />
                <span className="bg-value">{s.type === 'boolean' || s.anyOf ? '' : formatSetting(s, value)}</span>
                <button
                  type="button"
                  className="bg-reset"
                  style={{ visibility: changed ? 'visible' : 'hidden' }}
                  title={`Reset ${(s.title ?? id).toLowerCase()}`}
                  aria-label={`Reset ${(s.title ?? id).toLowerCase()}`}
                  onClick={() =>
                    host.appearance.setBackground({
                      style,
                      params: { [id]: s.default as number | boolean },
                    })
                  }
                >
                  ↺
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="bg-panel-foot">↑↓ choose · → or tab to settings · ←→ adjust, shift for more · esc close</div>
    </div>
  );
}
