/**
 * The tiles the agent suggested, as a strip between the history and the input. Each one is a live
 * preview, unless it's already on screen: then it shows its title, and hovering it outlines the tile
 * it duplicates. Click or Enter adds one, dragging drops it where the pointer lets go.
 *
 * In build mode, a mod the build added or changed shows as a draft: its preview works, so the viewer can
 * try it there, and its name underneath is what adds or drags it. See docs/BUILD_MODE.md.
 *
 * A preview can be resized by hand from its right edge, bottom edge or corner; double-clicking one of
 * them gives it back its own shape. See `clampPreviewSize` for the limits.
 *
 * Keys, once a suggestion has focus: ← → move, Enter adds, ↓ or typing goes back to the input,
 * Esc is the palette's (see CommandPalette).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ComponentView, host, previewScope, PreviewScope, tilesOf, useLive, type ComponentSpec } from '../host';
import { clampPreviewSize, manualSizes, MAX_PREVIEW_HEIGHT_OF_WINDOW, previewAspect } from './stripShape';

export interface SuggestionStripHandle {
  /** Gives the strip keyboard focus, on the suggestion it last had. */
  focus(): void;
}

const DRAG_THRESHOLD_PX = 4;

/** The edges a preview is resized from: its right, its bottom, or the corner between them. */
type Edge = 'e' | 's' | 'se';
const EDGES: readonly Edge[] = ['e', 's', 'se'];

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
  const building = useLive((s) => s.build.active);
  const changes = useLive((s) => s.build.changes);
  /** What build mode did to a component, by name: its preview is a draft the viewer can try. */
  const drafts = useMemo(
    () => new Map(building ? changes.filter((c) => c.change !== 'deleted').map((c) => [c.name, c.change === 'added' ? 'draft' : 'edited'] as const) : []),
    [building, changes],
  );
  /** Inside a draft's preview, the mouse and keys belong to the component being tried. */
  const insideDraft = (spec: ComponentSpec, target: EventTarget | null) => drafts.has(spec.type) && target instanceof Element && target.closest('.strip-view') != null;
  const [index, setIndex] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const suppressClick = useRef(false);
  /** Re-renders when a size in `manualSizes` changes. */
  const [, setResized] = useState(0);

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
    if (e.target !== e.currentTarget && insideDraft(spec, e.target)) return;
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
    if (e.button !== 0 || onScreen.has(spec.key) || insideDraft(spec, e.target)) return;
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

  /** Resizing never starts a drag or adds the card, and never reaches a draft's own content. */
  const onResizeStart = (e: PointerEvent<HTMLDivElement>, spec: ComponentSpec, edge: Edge) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const grip = e.currentTarget;
    const view = grip.closest('.strip-view');
    const strip = grip.closest('.strip');
    if (!view || !strip) return;
    const start = view.getBoundingClientRect();
    const padding = getComputedStyle(strip);
    const maxWidth = strip.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
    const startX = e.clientX;
    const startY = e.clientY;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      const width = start.width + (edge === 's' ? 0 : ev.clientX - startX);
      const height = start.height + (edge === 'e' ? 0 : ev.clientY - startY);
      manualSizes.set(spec.key, clampPreviewSize({ width, height }, maxWidth, window.innerHeight * MAX_PREVIEW_HEIGHT_OF_WINDOW));
      setResized((n) => n + 1);
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };

  const resetSize = (spec: ComponentSpec) => {
    manualSizes.delete(spec.key);
    setResized((n) => n + 1);
  };

  return (
    <div className="strip" data-testid="suggestion-strip" role="listbox" aria-label="Suggested tiles" aria-orientation="horizontal">
      {items.map((spec, i) => {
        const present = onScreen.has(spec.key);
        const draft = present ? undefined : drafts.get(spec.type);
        const manual = manualSizes.get(spec.key);
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
            className={`strip-item ${present ? 'strip-item-present' : ''} ${draft ? 'strip-item-draft' : ''} ${drag?.key === spec.key && drag.moved ? 'strip-item-dragging' : ''}`}
            data-testid="suggestion"
            data-key={spec.key}
            data-draft={draft}
            data-on-screen={present}
            data-resized={manual ? true : undefined}
            style={manual ? { width: manual.width } : undefined}
            onFocus={() => {
              setIndex(i);
              host.suggestions.highlight({ key: spec.key });
            }}
            onBlur={() => host.suggestions.highlight({ key: null })}
            onMouseEnter={() => host.suggestions.highlight({ key: spec.key })}
            onMouseLeave={() => host.suggestions.highlight({ key: null })}
            onPointerDown={(e) => onPointerDown(e, spec)}
            onClick={(e) => {
              if (insideDraft(spec, e.target) || (e.target instanceof Element && e.target.closest('.strip-resize'))) return;
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              add(spec, i);
            }}
            onKeyDown={(e) => onKeyDown(e, spec, i)}
          >
            <div
              className="strip-view"
              style={manual ? { height: manual.height } : { aspectRatio: previewAspect(spec.size?.aspect, draft ? 'draft' : 'suggestion') }} data-draft-type={draft ? spec.type : undefined}>
              {present ? (
                <div className="strip-placeholder">{spec.label}</div>
              ) : (
                <PreviewScope>
                  <ComponentView spec={spec} scope={previewScope(spec.key)} fallback={<div className="strip-placeholder">{spec.label}</div>} />
                </PreviewScope>
              )}
              {draft ? null : (
                <div className="strip-overlay" aria-hidden>
                  {present ? 'already on screen' : '+'}
                </div>
              )}
              {EDGES.map((edge) => (
                <div
                  key={edge}
                  className={`strip-resize strip-resize-${edge}`}
                  data-testid={`strip-resize-${edge}`}
                  aria-hidden
                  onPointerDown={(e) => onResizeStart(e, spec, edge)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    resetSize(spec);
                  }}
                />
              ))}
            </div>
            <div className="strip-label">
              <span className="strip-label-text">{spec.label}</span>
              {present ? <span className="strip-badge">on screen</span> : null}
              {draft ? (
                <span className="strip-badge strip-badge-draft" data-testid="draft-badge">
                  {draft}
                </span>
              ) : null}
              {draft ? <span className="strip-add">+ add</span> : null}
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
