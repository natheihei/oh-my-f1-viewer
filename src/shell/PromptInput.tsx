/**
 * The palette's input: text, with mentions among it as tags. Typing `@` opens a picker of what can be
 * mentioned (see src/shell/mentions.ts); picking a row puts its tag where the `@` was. A tag is one piece:
 * the caret steps over it, and Backspace just after it turns it back into the `@` text that found it, with
 * the picker open again.
 *
 * It's a contenteditable box, not a textarea, so a tag can be drawn as the code library draws a driver.
 * React renders the box once and leaves what's in it to the browser; the prompt is read back from the DOM.
 * The palette draws the picker, from what `onPicker` reports, and drives it through the handle.
 *
 * What a mention names can change while it's being typed or sits in the prompt: the agent opens and closes
 * tiles during its turn. The picker searches again, keeping its row while that's still there, and each tag
 * is drawn again, so a tile that has closed shows as closed.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { mentionElement, searchMentions, updateTags, useMentionSources } from './mentionKinds';
import { mentionQuery, type Mention, type MentionOption, type PromptPart } from './mentions';

export interface PromptInputHandle {
  focus(): void;
  /** Replaces the prompt with plain text, the caret at its end. */
  setText(text: string): void;
  /** Puts the picker's row in place of the `@` being typed. */
  pick(index: number): void;
  /** Selects the picker's row, as the arrow keys do. */
  select(index: number): void;
}

export interface Picker {
  options: MentionOption[];
  selected: number;
  /** A bare `@`: the rows go by kind, under each kind's heading. */
  grouped: boolean;
}

interface Props {
  placeholder: string;
  /** The prompt, each time it changes. */
  onChange(parts: PromptPart[]): void;
  /** The picker as it is now, or null when it's closed. */
  onPicker(picker: Picker | null): void;
  /** Keys the picker doesn't take. */
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
}

/** The `@` being typed: the text node it's in, where it starts and where the caret is. */
interface Query {
  node: Text;
  start: number;
  end: number;
  query: string;
}

const isTag = (n: Node | null | undefined): n is HTMLElement => n instanceof HTMLElement && n.dataset.mentionKind != null;

/** The prompt in the box: its text, and each tag as its mention. */
function readParts(box: HTMLElement): PromptPart[] {
  const parts: PromptPart[] = [];
  const add = (s: string) => {
    if (!s) return;
    if (typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += s;
    else parts.push(s);
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child instanceof Text) add(child.data.replace(/ /g, ' '));
      else if (isTag(child)) parts.push({ kind: child.dataset.mentionKind!, id: child.dataset.mentionId! });
      else if (child instanceof HTMLBRElement) add(child.nextSibling ? '\n' : '');
      else walk(child);
    }
  };
  walk(box);
  return parts;
}

/** A tag for a mention, remembering the `@` text that found it. */
function tagFor(mention: Mention, typed: string): HTMLElement | null {
  const el = mentionElement(mention);
  if (!el) return null;
  el.contentEditable = 'false';
  el.dataset.mentionKind = mention.kind;
  el.dataset.mentionId = mention.id;
  el.dataset.typed = typed;
  el.classList.add('prompt-tag');
  return el;
}

function caretAfter(node: Node, offset?: number): void {
  const range = document.createRange();
  if (offset == null) range.setStartAfter(node);
  else range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export const PromptInput = forwardRef<PromptInputHandle, Props>(function PromptInput({ placeholder, onChange, onPicker, onKeyDown }, ref) {
  const box = useRef<HTMLDivElement | null>(null);
  const picker = useRef<(Picker & { at: Query }) | null>(null);
  /** An `@` whose picker Esc closed: it stays closed until that `@` is edited or the caret leaves it. */
  const dismissed = useRef<{ node: Text; start: number; query: string } | null>(null);
  const callbacks = useRef({ onChange, onPicker });
  callbacks.current = { onChange, onPicker };

  const setPicker = (next: (Picker & { at: Query }) | null) => {
    const prev = picker.current;
    picker.current = next;
    if (prev == null && next == null) return;
    callbacks.current.onPicker(next ? { options: next.options, selected: next.selected, grouped: next.grouped } : null);
  };

  /** The `@` the caret is in, if any: only within one run of text, and not in a `/` command. */
  const currentQuery = (): Query | null => {
    const el = box.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
    const { startContainer: node, startOffset: end } = selection.getRangeAt(0);
    if (!(node instanceof Text) || !el.contains(node)) return null;
    if (el.textContent?.trimStart().startsWith('/')) return null;
    const found = mentionQuery(node.data.slice(0, end).replace(/ /g, ' '));
    return found ? { node, start: found.start, end, query: found.query } : null;
  };

  const refreshPicker = () => {
    const at = currentQuery();
    const was = dismissed.current;
    if (was && (at?.node !== was.node || at.start !== was.start || at.query !== was.query)) dismissed.current = null;
    if (!at || dismissed.current) return setPicker(null);
    const options = searchMentions(at.query);
    if (options.length === 0) return setPicker(null);
    // The same `@` keeps its row, wherever the row has moved to, as rows come and go.
    const prev = picker.current;
    const same = prev && prev.at.node === at.node && prev.at.start === at.start && prev.at.query === at.query;
    const row = same ? prev.options[prev.selected] : undefined;
    const kept = row ? options.findIndex((o) => o.kind === row.kind && o.id === row.id) : -1;
    setPicker({ options, selected: Math.max(kept, 0), grouped: at.query === '', at });
  };

  const changed = () => {
    const el = box.current;
    if (!el) return;
    const parts = readParts(el);
    // An emptied box can keep a stray <br>, which would hide the placeholder.
    if (parts.length === 0 && el.childNodes.length > 0) el.replaceChildren();
    callbacks.current.onChange(parts);
    refreshPicker();
  };

  const pick = (index: number) => {
    const open = picker.current;
    const option = open?.options[index];
    if (!open || !option) return;
    const { node, start, end } = open.at;
    const tag = tagFor(option, node.data.slice(start, end));
    if (!tag) return;
    const after = node.splitText(start);
    after.deleteData(0, end - start);
    node.parentNode!.insertBefore(tag, after);
    // One space after the tag, unless the text after it starts with one already.
    if (!/^[ \u00a0]/.test(after.data)) after.insertData(0, ' ');
    caretAfter(after, 1);
    changed();
  };

  /** Backspace just after a tag: the tag turns back into the `@` text that found it. */
  const untag = (): boolean => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const { startContainer: node, startOffset: offset } = selection.getRangeAt(0);
    const before = node instanceof Text ? (offset === 0 ? node.previousSibling : null) : node.childNodes[offset - 1];
    if (!isTag(before)) return false;
    const typed = before.dataset.typed || '@';
    // Into the text before it, if any, and with the text after it, so the `@` is one run the picker can read.
    const prev = before.previousSibling;
    const run = prev instanceof Text ? prev : document.createTextNode('');
    if (run !== prev) before.before(run);
    run.appendData(typed);
    const caret = run.length;
    before.remove();
    if (run.nextSibling instanceof Text) {
      run.appendData(run.nextSibling.data);
      run.nextSibling.remove();
    }
    caretAfter(run, caret);
    dismissed.current = null;
    changed();
    return true;
  };

  /** Focuses the box with the caret at the end. */
  const focusEnd = () => {
    const el = box.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  };

  useImperativeHandle(
    ref,
    () => ({
      focus: focusEnd,
      setText(text) {
        const el = box.current;
        if (!el) return;
        el.replaceChildren(...(text ? [document.createTextNode(text)] : []));
        if (document.activeElement === el) focusEnd();
        changed();
      },
      pick,
      select(index) {
        const open = picker.current;
        if (open && open.selected !== index && index >= 0 && index < open.options.length) setPicker({ ...open, selected: index });
      },
    }),
    [],
  );

  // What the mentions name changing: tags draw it, and an open picker searches again.
  const sources = useMentionSources();
  useEffect(() => {
    if (box.current) updateTags(box.current);
    if (picker.current) refreshPicker();
  }, sources);

  // The caret moving into or out of an `@`, by arrow keys or a click, opens or closes the picker.
  useEffect(() => {
    const onSelection = () => {
      if (document.activeElement === box.current) refreshPicker();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const open = picker.current;
    if (open && !e.nativeEvent.isComposing) {
      const n = open.options.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const selected = (open.selected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        setPicker({ ...open, selected });
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        pick(open.selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissed.current = { node: open.at.node, start: open.at.start, query: open.at.query };
        setPicker(null);
        return;
      }
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && untag()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onKeyDown(e);
  };

  // Pasted text comes in plain, on one line, as typed text would.
  const paste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r?\n/g, ' ');
    if (text) document.execCommand('insertText', false, text);
  };

  return (
    <div
      ref={box}
      data-testid="palette-input"
      className="palette-input"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="false"
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      onInput={changed}
      onKeyDown={keyDown}
      onPaste={paste}
      onDrop={(e) => e.preventDefault()}
      onBlur={() => setPicker(null)}
      onFocus={refreshPicker}
    />
  );
});
