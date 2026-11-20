/**
 * The spoiler check, between the palette's history and the input. It says nothing about what the agent
 * is after, only that it wants to look ahead of where the viewer is. ← → move between answers, Enter
 * answers, Esc doesn't allow. Space does nothing here, so reaching for play/pause can't answer it.
 */
import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { lookAhead, type LookAheadAnswer } from './lookAhead';
import { isPaletteKey } from './paletteKey';

export interface LookAheadPromptHandle {
  focus(): void;
}

const ANSWERS: { answer: LookAheadAnswer; label: string }[] = [
  { answer: 'once', label: 'Allow once' },
  { answer: 'session', label: 'Allow for this session' },
  { answer: 'no', label: "Don't allow" },
];

export const LookAheadPrompt = forwardRef<LookAheadPromptHandle>(function LookAheadPrompt(_props, ref) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  useImperativeHandle(ref, () => ({ focus: () => buttons.current[0]?.focus() }), []);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    // The palette's shortcut still reaches the palette; nothing else leaves the prompt.
    if (!isPaletteKey(e)) e.stopPropagation();
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + ANSWERS.length) % ANSWERS.length;
      buttons.current[next]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      lookAhead.answer('no');
    } else if (e.key === ' ') {
      e.preventDefault();
    }
  };

  return (
    <>
      <div className="spoiler" data-testid="spoiler-check" role="alertdialog" aria-label="Spoiler check">
        <div>
          <span className="spoiler-label">! spoiler</span> The agent wants to look ahead of where you are.
        </div>
        <div className="spoiler-actions">
          {ANSWERS.map(({ answer, label }, i) => (
            <button
              key={answer}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              className="spoiler-answer"
              data-testid={`spoiler-${answer}`}
              onClick={() => lookAhead.answer(answer)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="strip-hint">← → choose · enter answer · esc don't allow</div>
    </>
  );
});
