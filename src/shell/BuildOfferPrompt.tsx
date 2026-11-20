/**
 * The viewing agent's offer of build mode, as "<reason> in build mode?", laid out as the spoiler check is,
 * between the history and the input. Entering build mode lets its agent look ahead without asking, so the
 * offer says what `/build` says in red. ← → move between answers, Enter answers, Esc stays.
 */
import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import type { BuildOffer } from '../host';
import { offerReason, stayInView, switchToBuild } from './buildMode';
import { isPaletteKey } from './paletteKey';

export interface BuildOfferPromptHandle {
  focus(): void;
}

export const BuildOfferPrompt = forwardRef<BuildOfferPromptHandle, { offer: BuildOffer }>(function BuildOfferPrompt({ offer }, ref) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useImperativeHandle(ref, () => ({ focus: () => buttons.current[0]?.focus() }), []);

  const answers = [
    { label: 'Switch to build', testid: 'offer-switch', build: true, run: () => void switchToBuild(offer) },
    { label: 'Stay in view mode', testid: 'offer-stay', build: false, run: stayInView },
  ];

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    // The palette's shortcut still reaches the palette; nothing else leaves the prompt.
    if (!isPaletteKey(e)) e.stopPropagation();
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      buttons.current[(i + 1) % answers.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stayInView();
    } else if (e.key === ' ') {
      e.preventDefault();
    }
  };

  return (
    <>
      <div className="spoiler build-offer" data-testid="build-offer" role="alertdialog" aria-label="Offer of build mode">
        <div>
          <div>
            {offerReason(offer.reason, true)} in <span className="build-offer-mode">build mode</span>?
          </div>
          <div>
            <span className="spoiler-label">! spoiler</span> <span className="build-offer-why">the build agent looks ahead without asking</span>
          </div>
        </div>
        <div className="spoiler-actions">
          {answers.map(({ label, testid, build, run }, i) => (
            <button
              key={testid}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              className={`spoiler-answer ${build ? 'build-offer-switch' : ''}`}
              data-testid={testid}
              onClick={run}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="strip-hint">← → choose · enter answer · esc stay</div>
    </>
  );
});
