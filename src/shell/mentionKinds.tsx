/**
 * What the prompt can mention. Each kind searches what it has now, draws its tag (in the DOM for the
 * prompt, and in React for the history and the picker) and says it as text for the agent. A new kind is
 * one more entry here. See src/shell/mentions.ts.
 */
import { Fragment, type ReactNode } from 'react';
import { codeOf, driverCodeElement, DriverCode, read, type CodeLook } from '../host';
import { searchDrivers, sayDriver, type Mention, type MentionOption, type PromptPart } from './mentions';

export interface MentionKind {
  name: string;
  /** The rows for what follows the `@`, best first: none when the kind has nothing to offer now. */
  search(query: string): MentionOption[];
  /** The tag as a DOM element, for the prompt. */
  element(id: string, look: CodeLook): HTMLElement;
  /** The tag in React, for the history and the picker. */
  render(id: string, look: CodeLook): ReactNode;
  /** The mention as the agent reads it. */
  say(id: string): string;
}

const driver: MentionKind = {
  name: 'driver',
  search(query) {
    const data = read().sessionData;
    return data.state === 'ready' ? searchDrivers(data.drivers, query) : [];
  },
  element: (id, look) => driverCodeElement(Number(id), look),
  render: (id, look) => <DriverCode number={Number(id)} {...look} />,
  say: (id) => sayDriver(codeOf(Number(id)), Number(id)),
};

export const MENTION_KINDS: readonly MentionKind[] = [driver];

const kindOf = (name: string): MentionKind | undefined => MENTION_KINDS.find((k) => k.name === name);

/** A tag's look: the code library's bold bar, in the colour of the text around it. */
export const TAG_LOOK: CodeLook = { variant: 'bar', strong: true, tone: 'inherit' };

/** Every kind's rows for a query, best first. */
export function searchMentions(query: string): MentionOption[] {
  return MENTION_KINDS.flatMap((k) => k.search(query)).sort((a, b) => a.rank - b.rank);
}

export const sayMention = (m: Mention): string => kindOf(m.kind)?.say(m.id) ?? '';

export function mentionElement(m: Mention, look: CodeLook = TAG_LOOK): HTMLElement | null {
  return kindOf(m.kind)?.element(m.id, look) ?? null;
}

export function renderMention(m: Mention, look: CodeLook = TAG_LOOK): ReactNode {
  return kindOf(m.kind)?.render(m.id, look) ?? sayMention(m);
}

/** A prompt in the history: its text, with each mention drawn as its tag. */
export function MentionParts({ parts }: { parts: readonly PromptPart[] }): ReactNode {
  return parts.map((p, i) => (typeof p === 'string' ? p : <Fragment key={i}>{renderMention(p)}</Fragment>));
}
