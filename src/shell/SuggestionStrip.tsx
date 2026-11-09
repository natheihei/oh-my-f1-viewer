/**
 * The tiles the agent suggested, as a strip between the history and the input. Each one is a live
 * preview, unless it's already on screen: then it shows its title, and hovering it outlines the tile
 * it duplicates. Click or Enter adds one, dragging drops it where the pointer lets go.
 *
 * Keys, once a suggestion has focus: ← → move, Enter adds, ↓ or typing goes back to the input,
 * Esc is the palette's (see CommandPalette).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ComponentView, host, PreviewScope, tilesOf, useLive, type ComponentSpec } from '../host';

export interface SuggestionStripHandle {
  /** Gives the strip keyboard focus, on the suggestion it last had. */
  focus(): void;
}

const DRAG_THRESHOLD_PX = 4;

interface Drag {
  key: string;
  label: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
}

export const SuggestionStrip = forwardRef<
  SuggestionStripHandle,
  { items: ComponentSpec[]; onLeave: () => void; onEscape: () => void }
>(function SuggestionStrip({ items, onLeave, onEscape }, ref) {
  const layout = useLive((s) => s.layout);
  const onScreen = useMemo(() => new Set(tilesOf(layout).map((t) => t.component.key)), [layout]);
  const [index, setIndex] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const suppressClick = useRef(false);

  const current = Math.min(index, items.length - 1);

  useImperativeHandle(ref, () => ({ focus: () => cards.current[Math.max(0, current)]?.focus() }), [current]);

  // Keep focus in the strip as suggestions leave it, on the one that took the added one's place.
  useEffect(() => {
    if (index > items.length - 1 && items.length > 0) setIndex(items.length - 1);
  }, [index, items.length]);

  const add = (spec: ComponentSpec, i: number) => {
    const wasFocused = cards.current.includes(document.activeElement as HTMLDivElement);
    host.suggestions.add({ key: spec.key });
    host.suggestions.highlight({ key: null });
    if (items.length <= 1) onLeave();
    else if (wasFocused) {
      const next = Math.min(i, items.length - 2);
      setIndex(next);
      // The list re-renders without the added one; focus whichever card sits at that index then.
      requestAnimationFrame(() => cards.current[next]?.focus());
    }
  };

  const onKeyDown = (e: KeyboardEvent, spec: ComponentSpec, i: number) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      setIndex(next);
      cards.current[next]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(spec, i);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onLeave();
    } else if (e.key.length === 1) {
      // Typing goes to the input: moving focus first lets this very key land there.
      onLeave();
    }
  };

  const onPointerDown = (e: PointerEvent, spec: ComponentSpec) => {
    if (e.button !== 0 || onScreen.has(spec.key)) return;
    const start: Drag = { key: spec.key, label: spec.label, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false };
    let state = start;
    const move = (ev: globalThis.PointerEvent) => {
      const moved = state.moved || Math.hypot(ev.clientX - start.startX, ev.clientY - start.startY) > DRAG_THRESHOLD_PX;
      state = { ...state, x: ev.clientX, y: ev.clientY, moved };
      if (!moved) return;
      setDrag(state);
      host.suggestions.dragOver({ key: spec.key, x: ev.clientX, y: ev.clientY });
    };
    const end = (ev: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setDrag(null);
      if (!state.moved) return;
      suppressClick.current = true;
      if (ev.type === 'pointercancel' || !host.suggestions.drop({ key: spec.key, x: ev.clientX, y: ev.clientY })) {
        host.suggestions.cancelDrag();
        return;
      }
      host.suggestions.highlight({ key: null });
      if (items.length <= 1) onLeave();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <div className="strip" data-testid="suggestion-strip" role="listbox" aria-label="Suggested tiles" aria-orientation="horizontal">
      {items.map((spec, i) => {
        const present = onScreen.has(spec.key);
        return (
          <div
            key={spec.key}
            ref={(el) => {
              cards.current[i] = el;
            }}
            role="option"
            aria-selected={i === current}
            aria-label={present ? `${spec.label}, already on screen` : `Add ${spec.label}`}
            tabIndex={i === current ? 0 : -1}
            className={`strip-item ${present ? 'strip-item-present' : ''} ${drag?.key === spec.key && drag.moved ? 'strip-item-dragging' : ''}`}
            data-testid="suggestion"
            data-key={spec.key}
            data-on-screen={present}
            onFocus={() => {
              setIndex(i);
              host.suggestions.highlight({ key: spec.key });
            }}
            onBlur={() => host.suggestions.highlight({ key: null })}
            onMouseEnter={() => host.suggestions.highlight({ key: spec.key })}
            onMouseLeave={() => host.suggestions.highlight({ key: null })}
            onPointerDown={(e) => onPointerDown(e, spec)}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              add(spec, i);
            }}
            onKeyDown={(e) => onKeyDown(e, spec, i)}
          >
            <div className="strip-view">
              {present ? (
                <div className="strip-placeholder">{spec.label}</div>
              ) : (
                <PreviewScope>
                  <ComponentView spec={spec} fallback={<div className="strip-placeholder">{spec.label}</div>} />
                </PreviewScope>
              )}
              <div className="strip-overlay" aria-hidden>
                {present ? 'already on screen' : '+'}
              </div>
            </div>
            <div className="strip-label">
              <span className="strip-label-text">{spec.label}</span>
              {present ? <span className="strip-badge">on screen</span> : null}
            </div>
          </div>
        );
      })}
      {/* On the body: the palette is transformed, which would offset anything fixed inside it. */}
      {drag?.moved
        ? createPortal(
            <div className="strip-ghost" style={{ left: drag.x, top: drag.y }}>
              {drag.label}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
