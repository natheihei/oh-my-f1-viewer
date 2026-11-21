/**
 * Driver codes, drawn one way wherever they appear. See docs/COMPONENTS.md, "Driver codes".
 *
 * A code is a driver, not a string: everything here takes a car number and finds its code and team
 * colour in the session's roster. How it looks is a variant, chosen by the caller. The library names
 * looks, not places: a title bar, a table and a line of text pick from the same set, so the same look
 * reads the same everywhere and a new place doesn't add a case.
 *
 * Here: the variants, the roster's styles, plain text, and the DOM and React renderers. The kit draws
 * the same variants on a canvas (`drawCode`, `drawParts`), from the same sizes.
 */
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { rosterOf, type DriverEntry } from '../../shared/sessionData';
import { driverStyles, labelText as plainLabel, partsText as plainParts, styleOf, type CodeLook, type DriverStyle, type Part } from './codes';
// The data stores themselves, not `live`: the host's own modules import this, and `live` imports them.
import { useSession } from '../data/session';
import { useSessionData } from '../data/sessionData';

export { CODE_BAR, CODE_WEIGHT, driverStyles, styleOf, type CodeLook, type CodeTone, type CodeVariant, type DriverStyle, type Part } from './codes';

/** Each driver's code, team colour and dash, by car number, from the session's roster. */
export function useDriverStyles(): Map<number, DriverStyle> {
  const drivers = useSessionData(rosterOf);
  return useMemo(() => driverStyles(drivers), [drivers]);
}

/** A car's code: from the roster, else its onboard feed, else the number itself. */
export function codeOf(number: number): string {
  const sessionData = useSessionData.getState();
  const feeds = useSession.getState().channels;
  const entry = rosterOf(sessionData).find((d) => d.driver_number === number);
  return entry?.name_acronym ?? feeds.find((f) => f.number === number)?.label ?? String(number);
}

/** The parts as plain text, each driver as its code. */
export const partsText = (parts: readonly Part[], code: (number: number) => string = codeOf): string => plainParts(parts, code);

/** A tile's label as text: its name, then its drivers' codes. "Gap NOR · PIA". */
export const labelText = (name: string, drivers: readonly number[], code: (number: number) => string = codeOf): string => plainLabel(name, drivers, code);

/** The roster's styles now, for code that draws outside React. */
let last: { drivers: readonly DriverEntry[]; styles: Map<number, DriverStyle> } | null = null;
function currentStyles(): Map<number, DriverStyle> {
  const sessionData = useSessionData.getState();
  const drivers = rosterOf(sessionData);
  if (last?.drivers !== drivers) last = { drivers, styles: driverStyles(drivers) };
  return last.styles;
}

/** The class names and team colour a code is drawn with in the DOM: see `.driver-code` in styles.css. */
function domLook(style: DriverStyle, look: CodeLook): { className: string; colour: string } {
  const { variant = 'bar', strong = false, tone = 'ink' } = look;
  return {
    className: ['driver-code', `driver-code-${variant}`, `driver-code-${tone}`, strong ? 'driver-code-strong' : ''].filter(Boolean).join(' '),
    colour: style.colour,
  };
}

/**
 * A code as a DOM element, for chrome built without React, such as a tile's title bar. Its text is the
 * code alone, so copying or reading it gives "HAM".
 */
export function driverCodeElement(number: number, look: CodeLook = {}, styles: Map<number, DriverStyle> = currentStyles()): HTMLSpanElement {
  const style = styleOf(styles, number);
  const { className, colour } = domLook(style, look);
  const el = document.createElement('span');
  el.className = className;
  el.style.setProperty('--team', colour);
  el.dataset.driver = String(number);
  el.textContent = style.code;
  return el;
}

/** A code in React. */
export function DriverCode({ number, ...look }: { number: number } & CodeLook) {
  const styles = useDriverStyles();
  const style = styleOf(styles, number);
  const { className, colour } = domLook(style, look);
  return (
    <span className={className} style={{ '--team': colour } as CSSProperties} data-driver={number}>
      {style.code}
    </span>
  );
}

/** Text with drivers in it, each drawn as a code in `look`. */
export function Parts({ parts, look }: { parts: readonly Part[]; look?: CodeLook }): ReactNode {
  return parts.map((p, i) => (typeof p === 'string' ? p : <DriverCode key={i} number={p.driver} {...look} />));
}

/**
 * Fills a tile's title: its name, then each driver as a strong `bar` code, so whose tile it is reads
 * at a glance. A title that names no drivers is its label as text.
 */
export function fillTitle(
  el: HTMLElement,
  spec: { label: string; title?: { name: string; drivers: number[] } },
  styles: Map<number, DriverStyle> = currentStyles(),
): void {
  if (!spec.title) {
    el.textContent = spec.label;
    return;
  }
  el.replaceChildren();
  if (spec.title.name) el.append(`${spec.title.name} `);
  spec.title.drivers.forEach((d, i) => {
    if (i) el.append(' · ');
    el.append(driverCodeElement(d, { strong: true }, styles));
  });
}
