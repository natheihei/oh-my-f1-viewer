/**
 * The app's only control surface besides the timeline: an input box, plus a short history box when
 * there is history, and between them the spoiler check, an offer of build mode, the agent's suggested
 * tiles and the tiles' errors attached to the next message. Older history is a scroll away. Sits above
 * the timeline, over the video. It stays open while any of those wait on the viewer.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent } from 'react';
import { host, read, useLive } from '../host';
import { AgentPanel, describeAgent } from './AgentPanel';
import { AttachTag, AttachTray } from './AttachTray';
import { BackgroundPanel } from './BackgroundPanel';
import { BuildOfferPrompt, type BuildOfferPromptHandle } from './BuildOfferPrompt';
import { sendToAgent, stopTurn } from './agentFeed';
import { leaveBuild } from './buildMode';
import { availableCommands, matchCommands, parseCommand, reportReadiness, runCommand, SLASH_COMMANDS, splitCommands, type NamedCommand } from './commands';
import { useOnboarding } from './onboardingState';
import { lookAhead, sessionAllowed, useLookAhead } from './lookAhead';
import { LookAheadPrompt, type LookAheadPromptHandle } from './LookAheadPrompt';
import { groupOf, MentionParts, pointAt, renderMention, sayMention } from './mentionKinds';
import { promptText, type PromptPart } from './mentions';
import { AUTO_HIDE_MS, palette, usePalette, type EntryRole, type PaletteEntry } from './palette';
import {
  MAC,
  bindingLabel,
  bindingOf,
  DEFAULT_PALETTE_KEY,
  isDefaultBinding,
  isPaletteKey,
  refusal,
  sameBinding,
  setPaletteKey,
  usePaletteKey,
  usePaletteKeyLabel,
  type PaletteBinding,
} from './paletteKey';
import { clampHistoryHeight, minHistoryHeight, setPaletteHeight, usePaletteHeight } from './persistPaletteHeight';
import { nextTip, TIP_MS, tipParts, type Tip } from './tips';
import { PromptInput, type Picker, type PromptInputHandle } from './PromptInput';
import { SuggestionStrip, type SuggestionStripHandle } from './SuggestionStrip';

/** While the agent is still working, a second Esc this soon after the first stops it. */
const ESC_AGAIN_MS = 2000;

/** The mark before each line of the history. It hangs in its own column, so wrapped text stays clear of it. */
const ROLE_MARK: Record<EntryRole, string> = {
  user: '>',
  agent: '',
  system: '#',
  error: '!',
};

/**
 * A system or error line's text, with each command it names as a button that runs it. The viewer's own lines
 * and the agent's aren't: what's typed isn't a suggestion, and the agent doesn't know the commands.
 */
function CommandText({ text, onRun }: { text: string; onRun: (named: NamedCommand) => void }) {
  return (
    <>
      {splitCommands(text).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <button key={i} type="button" className="palette-command" data-testid="palette-command" title={`Run ${part.text}`} onClick={() => onRun(part)}>
            {part.text}
          </button>
        ),
      )}
    </>
  );
}

/** The prompt without the spaces around it, as `text.trim()` leaves its text. */
function trimParts(parts: PromptPart[]): PromptPart[] {
  const out = [...parts];
  if (typeof out[0] === 'string') out[0] = out[0].trimStart();
  const last = out.length - 1;
  if (typeof out[last] === 'string') out[last] = (out[last] as string).trimEnd();
  return out.filter((p) => p !== '');
}

export function CommandPalette() {
  const { open, busy, entries, panel } = usePalette();
  const blank = useLive((s) => s.session == null);
  const onboardingActive = useOnboarding((s) => s.active);
  // Onboarding's last step is done here, so the palette lights up and offers an example while it's open.
  const pointing = useOnboarding((s) => s.active && s.pointing) && blank;
  /** The prompt, with its mentions, and as text: a mention as the agent reads it. */
  const [parts, setParts] = useState<PromptPart[]>([]);
  const value = promptText(parts, sayMention);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<PromptInputHandle | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<SuggestionStripHandle | null>(null);
  const promptRef = useRef<LookAheadPromptHandle | null>(null);
  const offerRef = useRef<BuildOfferPromptHandle | null>(null);
  const asking = useLookAhead((s) => s.asking);
  const attached = useLive((s) => s.attached);
  const offer = useLive((s) => s.build.offer);
  const contentId = useLive((s) => s.session?.contentId ?? null);
  const lookAheadAllowed = useLookAhead((s) => sessionAllowed(s, contentId));
  const tiles = useLive((s) => s.suggestions.items);
  const building = useLive((s) => s.build.active);
  const changeCount = useLive((s) => s.build.changes.length);
  const [armed, setArmed] = useState(false);
  const historyCap = usePaletteHeight((s) => s.height);
  /** The cap being dragged to, shown as the history's height until the drag ends. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyLabel = usePaletteKeyLabel();
  /** Waiting for the new shortcut, after a click on the key at the end of the input row. */
  const [recordingKey, setRecordingKey] = useState(false);
  /** Why the last key pressed while recording wasn't kept. */
  const [keyRefused, setKeyRefused] = useState<string | null>(null);

  // With nothing on screen the palette is the whole interface, so it can't be dismissed.
  const hasTiles = tiles.length > 0;
  // While building, the tag beside the input is the only way out, so the palette stays.
  // Attached errors and an offer of build mode wait on the viewer, so the palette stays for them too.
  const held = blank || hasTiles || asking || building || panel != null || attached.length > 0 || offer != null;
  const showing = open || held;
  const suggestions = matchCommands(value);

  // A timer that runs out while the palette is held leaves it be: hiding it then would only show once the hold ends.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const free = () => !heldRef.current;
  /** Focus moving into the palette keeps it open; leaving it for elsewhere in the app hides it after a while. */
  const focusProps = {
    ref: rootRef,
    onMouseDown: palette.keepOpen,
    onFocus: palette.keepOpen,
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      // Still in the palette when the time's up means the window lost focus, not the palette: leave it.
      palette.hideAfter(AUTO_HIDE_MS, () => free() && !rootRef.current?.contains(document.activeElement));
    },
  };

  // The picker's selected row outlines its tile, if it's one. The keys and the mouse both select a row.
  const pointed = picker ? picker.options[picker.selected] : null;
  useEffect(() => pointAt(pointed), [pointed?.kind, pointed?.id]);
  useEffect(() => () => pointAt(null), []);

  useEffect(() => {
    if (showing && !hasTiles) inputRef.current?.focus();
    // Only on showing: suggestions arriving take focus themselves, below.
  }, [showing]);

  // New suggestions keep the palette open, and take focus.
  useEffect(() => {
    if (!hasTiles) {
      disarm();
      return;
    }
    palette.show();
    if (!useLookAhead.getState().asking) requestAnimationFrame(() => stripRef.current?.focus());
  }, [hasTiles]);

  // A spoiler check takes focus, and gives it back once answered.
  const askedBefore = useRef(false);
  useEffect(() => {
    if (asking) {
      askedBefore.current = true;
      requestAnimationFrame(() => promptRef.current?.focus());
    } else if (askedBefore.current) {
      requestAnimationFrame(() => (read().suggestions.items.length > 0 ? stripRef.current?.focus() : inputRef.current?.focus()));
    }
  }, [asking]);

  // Attaching a tile's error opens the palette and puts the viewer in the input, to say more or send.
  // At once, not a frame later: what they type next belongs there, not to the tile's button.
  const attachedBefore = useRef(0);
  useEffect(() => {
    if (attached.length > attachedBefore.current) {
      palette.show();
      if (inputRef.current) inputRef.current.focus();
      else requestAnimationFrame(() => inputRef.current?.focus());
    }
    attachedBefore.current = attached.length;
  }, [attached.length]);

  // An offer of build mode takes focus, as the spoiler check does, and gives it back once answered.
  const offeredBefore = useRef(false);
  useEffect(() => {
    if (offer) {
      offeredBefore.current = true;
      if (!useLookAhead.getState().asking) offerRef.current?.focus();
    } else if (offeredBefore.current) {
      offeredBefore.current = false;
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [offer]);

  function disarm(): void {
    if (armedTimer.current != null) clearTimeout(armedTimer.current);
    armedTimer.current = null;
    setArmed(false);
  }

  /**
   * Esc with suggestions showing dismisses them. While the agent is still working it could suggest
   * more right after, so then it takes a second Esc, which also stops the turn.
   */
  const escapeTiles = () => {
    if (!usePalette.getState().busy) {
      host.suggestions.dismiss();
    } else if (armed) {
      host.suggestions.dismiss();
      void stopTurn();
    } else {
      setArmed(true);
      armedTimer.current = setTimeout(disarm, ESC_AGAIN_MS);
      return;
    }
    disarm();
    inputRef.current?.focus();
  };

  useLayoutEffect(() => {
    const box = historyRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    // Resizing keeps the latest lines in view too, as the box grows up from the input.
  }, [entries, showing, dragHeight, historyCap]);

  // Recording takes the next key press before anything else sees it, Esc and the palette's own shortcut included.
  useEffect(() => {
    if (!recordingKey || !showing) return;
    const stop = () => {
      setRecordingKey(false);
      setKeyRefused(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (bare && e.key === 'Escape') return stop();
      if (bare && e.key === 'Backspace') {
        changePaletteKey(null);
        return stop();
      }
      const pressed = bindingOf(e);
      if (!pressed) return;
      const why = refusal(pressed);
      if (why) return setKeyRefused(why);
      changePaletteKey(pressed);
      stop();
    };
    // A click anywhere but the key leaves it as it was.
    const onPointer = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest('[data-testid=palette-key]'))) stop();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [recordingKey, showing]);
  useEffect(() => {
    if (!showing || held) {
      setRecordingKey(false);
      setKeyRefused(null);
    }
  }, [showing, held]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteKey(e)) {
        e.preventDefault();
        if (usePalette.getState().open && !blank) palette.hide();
        else palette.show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blank]);

  /** Dragging the top edge up raises the history's cap, from wherever it is now, within its bounds. */
  const onResizeStart = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const min = minHistoryHeight(parseFloat(getComputedStyle(grip).getPropertyValue('--row')) || 22);
    const start = clampHistoryHeight(usePaletteHeight.getState().height ?? min, min, window.innerHeight);
    const startY = e.clientY;
    let height = start;
    grip.setPointerCapture(e.pointerId);
    setDragHeight(start);
    const move = (ev: globalThis.PointerEvent) => {
      height = clampHistoryHeight(start + startY - ev.clientY, min, window.innerHeight);
      setDragHeight(height);
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      setDragHeight(null);
      if (height !== start) setPaletteHeight(height > min ? height : null);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };

  // Hidden, the palette folds to its input row, see-through, and a click unfolds it. Only with a session open: without one it's held.
  if (!showing) return <FoldedPalette busy={busy} />;

  if (panel === 'background') {
    const closePanel = () => {
      palette.closePanel();
      const { style } = read().background;
      palette.push('system', `Background: ${read().backgrounds.find((b) => b.name === style)?.title ?? 'off'}.`);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    return (
      <div className={`palette ${building ? 'palette-building' : ''}`} data-testid="palette" data-building={building} {...focusProps}>
        <BackgroundPanel onClose={closePanel} />
      </div>
    );
  }

  if (panel === 'agent') {
    const closePanel = () => {
      requestAnimationFrame(() => inputRef.current?.focus());
      // A fix or onboarding that opened it says what changed itself.
      if (palette.closePanel()) return;
      void host.agent.status().then((status) => {
        const line = describeAgent(status);
        if (line) palette.push('system', line);
        return reportReadiness();
      });
    };
    return (
      <div className="palette" data-testid="palette" {...focusProps}>
        <AgentPanel onClose={closePanel} />
      </div>
    );
  }

  // Done, the palette goes after a while, as it does once the agent has acted. A panel or build mode holds it.
  const ranCommand = () => palette.hideAfter(AUTO_HIDE_MS, free);

  /**
   * A command a line names, clicked: it runs as if typed. One with a warning goes in the input instead, where the
   * list shows the warning beside it and Enter runs it.
   */
  const clickCommand = ({ command, rest }: NamedCommand) => {
    if (command.warning) {
      inputRef.current?.setText(`${command.name} `);
      inputRef.current?.focus();
      return;
    }
    runCommand(command, rest, ranCommand);
  };

  const submit = () => {
    // Said now, not as of the last render: a tile mentioned may have closed since.
    const text = promptText(parts, sayMention).trim();
    // Attached errors can go on their own, with no words.
    if (!text && attached.length === 0) return;
    const said = trimParts(parts);
    inputRef.current?.setText('');
    setSelected(0);
    if (text.startsWith('/')) {
      const { name, rest } = parseCommand(text);
      const command = SLASH_COMMANDS.find((c) => c.name === name) ?? (rest ? undefined : suggestions[selected]);
      if (command && (!rest || command.takesText)) runCommand(command, rest, ranCommand);
      else {
        palette.push('user', text);
        palette.push('error', `Unknown command. Available: ${availableCommands().map((c) => c.name).join(', ')}`);
      }
      return;
    }
    void sendToAgent(text, { parts: said });
  };

  return (
    <div className={`palette ${building ? 'palette-building' : ''} ${pointing ? 'palette-pointing' : ''}`} data-testid="palette" data-building={building} {...focusProps}>
      {blank && entries.length <= 1 && !onboardingActive ? (
        <div className="palette-intro" data-testid="palette-intro">
          <div>Watch an F1 TV session: feeds and timing as tiles, driven from here.</div>
          <div className="palette-intro-try">
            try <span className="palette-example">2025 Mexico race</span> <span className="palette-example">last qualifying</span>{' '}
            <span className="palette-example">/</span> for commands
          </div>
        </div>
      ) : null}
      {held ? null : (
        // No title: the chevron says what it does, and the key is written at the end of the input row.
        <button type="button" className="palette-hide" data-testid="palette-hide" aria-label={`Hide the palette (${keyLabel})`} onClick={palette.hide}>
          <Chevron />
        </button>
      )}
      {entries.length > 0 ? (
        <div
          className={`palette-resize ${dragHeight != null ? 'palette-resize-active' : ''}`}
          data-testid="palette-resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={onResizeStart}
          onDoubleClick={() => setPaletteHeight(null)}
        />
      ) : null}
      {entries.length > 0 ? (
        <div
          ref={historyRef}
          className="palette-history"
          data-testid="palette-history"
          style={
            {
              ...(historyCap != null ? { '--palette-history-cap': `${historyCap}px` } : {}),
              // Each fix still waiting on the viewer makes room for itself, so two never push each other out of view.
              '--palette-fixes': entries.filter((e) => e.fix).length,
              ...(dragHeight != null ? { height: dragHeight, maxHeight: dragHeight } : {}),
            } as CSSProperties
          }
        >
          {entries.map((entry) =>
            entry.fix ? (
              <FixBlock key={entry.id} entry={entry} />
            ) : (
            <div key={entry.id} className={`palette-line palette-${entry.role}`}>
              <span className="palette-mark">{ROLE_MARK[entry.role]}</span>
              <span className="palette-text">
                {entry.attached?.map((tag) => (
                  <Fragment key={tag.scope}>
                    <AttachTag tag={tag} />{' '}
                  </Fragment>
                ))}
                {entry.parts ? (
                  <MentionParts parts={entry.parts} />
                ) : entry.role === 'system' || entry.role === 'error' ? (
                  <CommandText text={entry.text} onRun={clickCommand} />
                ) : (
                  entry.text
                )}
                {entry.action ? (
                  <>
                    {' '}
                    <button type="button" className="palette-action" data-testid="palette-action" onClick={() => palette.act(entry.id)}>
                      {entry.action.label}
                    </button>
                  </>
                ) : null}
              </span>
            </div>
            ),
          )}
        </div>
      ) : null}
      {asking ? <LookAheadPrompt ref={promptRef} /> : null}
      {offer && !building ? <BuildOfferPrompt ref={offerRef} offer={offer} /> : null}
      {hasTiles ? (
        <>
          <SuggestionStrip ref={stripRef} items={tiles} onLeave={() => inputRef.current?.focus()} onEscape={escapeTiles} />
          <div className="strip-hint" data-testid="strip-hint">
            {armed
              ? 'esc again to dismiss and stop the agent'
              : building
                ? 'try the draft here · press enter or click its name to add it · drag its name to place it · esc dismiss'
                : '← → choose · enter add · drag to place · esc dismiss'}
          </div>
        </>
      ) : null}
      {attached.length > 0 ? <AttachTray attached={attached} busy={busy} /> : null}
      {recordingKey ? (
        <div className={`strip-hint ${keyRefused ? 'palette-key-refused' : ''}`} data-testid="palette-key-hint" role="status">
          {keyRefused ?? `press the new key · esc keep ${keyLabel} · backspace ${bindingLabel(DEFAULT_PALETTE_KEY)}`}
        </div>
      ) : null}
      {picker ? (
        <div
          className={`palette-suggestions palette-mentions ${picker.options.some((o) => o.kind !== 'driver') ? 'palette-mentions-wide' : ''}`}
          data-testid="mention-picker"
        >
          {picker.options.map((option, i) => (
            <Fragment key={`${option.kind}:${option.id}`}>
              {picker.grouped && option.kind !== picker.options[i - 1]?.kind ? (
                <div className="palette-mention-group" data-testid="mention-group">
                  {groupOf(option.kind)}
                </div>
              ) : null}
              <div
                className={`palette-suggestion palette-mention ${i === picker.selected ? 'palette-suggestion-active' : ''}`}
                data-testid="mention-option"
                ref={i === picker.selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                // On a move, not on entering: a row the keys scroll under a still mouse isn't selected.
                onMouseMove={() => {
                  if (i !== picker.selected) inputRef.current?.select(i);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  inputRef.current?.pick(i);
                }}
              >
                <span className="palette-mention-tag">{renderMention(option, { variant: 'bar' })}</span>
                <span className="palette-suggestion-desc">{option.detail}</span>
              </div>
            </Fragment>
          ))}
        </div>
      ) : suggestions.length > 0 ? (
        <div className="palette-suggestions" data-testid="palette-suggestions">
          {suggestions.map((command, i) => (
            <div
              key={command.name}
              className={`palette-suggestion ${i === selected ? 'palette-suggestion-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                inputRef.current?.setText(command.name);
                inputRef.current?.focus();
              }}
            >
              <span>{command.name}</span>
              <span className="palette-suggestion-desc">
                {command.description}
                {command.warning ? (
                  <span className="palette-suggestion-warning" data-testid="command-warning">
                    <span className="spoiler-label">! spoiler</span> {command.warning}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="palette-input-row">
        <span className={`palette-prompt ${busy ? 'palette-prompt-busy' : ''}`}>{busy ? '…' : '>'}</span>
        <PromptInput
          ref={inputRef}
          placeholder={
            building ? 'describe a tile to build, or a change to one' : pointing ? 'name a session, like 2025 Mexico race' : blank ? 'name a session, or / for commands' : 'ask for anything on screen'
          }
          onChange={(next) => {
            setParts(next);
            setSelected(0);
            palette.keepOpen();
          }}
          onPicker={setPicker}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (isPaletteKey(e)) {
              e.preventDefault();
              if (!blank) palette.hide();
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (value) inputRef.current?.setText('');
              else if (hasTiles) escapeTiles();
              else if (!blank && !building) palette.hide();
            } else if (e.key === 'Tab' && suggestions.length > 0) {
              e.preventDefault();
              inputRef.current?.setText(suggestions[selected].name);
            } else if (e.key === 'ArrowDown' && suggestions.length > 0) {
              e.preventDefault();
              setSelected((selected + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
              e.preventDefault();
              setSelected((selected - 1 + suggestions.length) % suggestions.length);
            } else if (e.key === 'ArrowUp' && hasTiles && !value) {
              e.preventDefault();
              stripRef.current?.focus();
            }
          }}
        />
        {building ? (
          <span className="build-tag" data-testid="build-tag">
            {changeCount === 0 ? (
              <button type="button" className="build-tag-button build-tag-label" data-testid="build-leave" title="Leave build mode" onClick={() => void leaveBuild('save')}>
                build ×
              </button>
            ) : (
              <>
                <span className="build-tag-label" data-testid="build-count">
                  build · {changeCount} {changeCount === 1 ? 'change' : 'changes'}
                </span>
                <button type="button" className="build-tag-button" data-testid="build-undo" title="Put the mods folder back as it was, and leave build mode" onClick={() => void leaveBuild('undo')}>
                  Undo all
                </button>
                <button type="button" className="build-tag-button build-tag-save" data-testid="build-save" title="Keep what was built, and leave build mode" onClick={() => void leaveBuild('save')}>
                  Save
                </button>
              </>
            )}
          </span>
        ) : null}
        {lookAheadAllowed ? (
          <button
            type="button"
            className="palette-tag"
            data-testid="spoiler-session-tag"
            title="The agent may look ahead for this session. Click to make it ask again."
            onClick={lookAhead.revokeSession}
          >
            looks ahead · ×
          </button>
        ) : null}
        {held ? null : (
          // The key is also how it's changed: a click records the next one pressed.
          <button
            type="button"
            className={`palette-key-button ${recordingKey ? 'palette-key-recording' : ''} ${keyRefused ? 'palette-key-refused' : ''}`}
            data-testid="palette-key"
            aria-label={recordingKey ? 'Press the new shortcut for the palette' : `Change the palette's shortcut (${keyLabel})`}
            aria-pressed={recordingKey}
            onClick={() => {
              palette.keepOpen();
              setKeyRefused(null);
              setRecordingKey((r) => !r);
            }}
          >
            {recordingKey ? null : <span className="palette-key-change">change</span>}
            <kbd className="palette-key">{recordingKey ? 'press keys' : keyLabel}</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The hidden palette: folded to its input row, in the same place and as wide, see-through so the video shows
 * behind it. It names the shortcut, and a click unfolds the palette with the cursor in the input.
 */
function FoldedPalette({ busy }: { busy: boolean }) {
  const keyLabel = usePaletteKeyLabel();
  // Each fold starts on the placeholder, then a tip takes its place every so often.
  const [tip, setTip] = useState<Tip | null>(null);
  // Under the pointer or with focus the line holds, so it can be read to the end.
  const held = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!held.current && !usePalette.getState().busy) setTip(nextTip());
    }, TIP_MS);
    return () => clearInterval(timer);
  }, []);
  // While the agent works the row says only what it's for.
  const shown = busy ? null : tip;
  // The line before this one, drawn under it while one fades into the other.
  const [lines, setLines] = useState<{ now: Tip | null; before?: Tip | null }>({ now: null });
  if (lines.now !== shown) setLines({ now: shown, before: lines.now });
  const hold = (on: boolean) => () => {
    held.current = on;
  };
  return (
    <button
      type="button"
      className="palette palette-folded"
      data-testid="palette-folded"
      aria-label={`Show the palette (${keyLabel})`}
      onClick={palette.show}
      onMouseEnter={hold(true)}
      onMouseLeave={hold(false)}
      onFocus={hold(true)}
      onBlur={hold(false)}
    >
      <span className={`palette-prompt ${busy ? 'palette-prompt-busy' : ''}`}>{busy ? '…' : '>'}</span>
      <span className="palette-folded-text">
        {lines.before !== undefined ? (
          <span key={`out:${lines.before?.id ?? ''}`} className="palette-folded-line palette-folded-line-out">
            <FoldedLine tip={lines.before} keyLabel={keyLabel} />
          </span>
        ) : null}
        <span
          key={lines.now?.id ?? ''}
          className={`palette-folded-line ${lines.before !== undefined ? 'palette-folded-line-in' : ''}`}
          data-testid="palette-folded-line"
          data-tip={lines.now?.id}
        >
          <FoldedLine tip={lines.now} keyLabel={keyLabel} />
        </span>
      </span>
      <kbd className="palette-key">{keyLabel}</kbd>
    </button>
  );
}

/** What the folded palette says: a tip, or what it's for. */
function FoldedLine({ tip, keyLabel }: { tip: Tip | null; keyLabel: string }) {
  if (!tip) return <>ask for anything on screen</>;
  return (
    <>
      <span className="palette-tip-label">tip</span>
      {tipParts(tip.text, { palette: keyLabel, mac: MAC }).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : 'key' in part ? (
          <kbd key={i} className="palette-key palette-tip-key">
            {part.key}
          </kbd>
        ) : (
          <span key={i} className="palette-tip-command">
            {part.command}
          </span>
        ),
      )}
    </>
  );
}

/** Sets the palette's shortcut, null for the default, and says so in the history if it changed. */
function changePaletteKey(next: PaletteBinding | null): void {
  const before = usePaletteKey.getState().binding;
  setPaletteKey(next && !isDefaultBinding(next) ? next : null);
  const now = usePaletteKey.getState().binding;
  if (sameBinding(before, now)) return;
  const label = bindingLabel(now);
  palette.push('system', isDefaultBinding(now) ? `${label} shows and hides the palette again, the default.` : `${label} shows and hides the palette now. Click it to change it again.`);
}

/** The chevron on the hide tab: points down, where the palette goes. */
function Chevron() {
  return (
    <svg viewBox="0 0 14 8" className="palette-hide-chevron" aria-hidden="true">
      <path d="M1 1l6 6 6-6" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

/** An error with its fix: what broke, what fixing it does, the button and the command that does the same. */
function FixBlock({ entry }: { entry: PaletteEntry }) {
  const fix = entry.fix!;
  return (
    <div className={`palette-fix ${fix.running ? 'palette-fix-running' : ''}`} data-testid="palette-fix" role="group" aria-label={entry.text}>
      <div className="palette-fix-head">
        <span className="palette-fix-mark" />
        <span>{fix.running ? fix.busy : entry.text}</span>
      </div>
      {fix.running ? null : <div className={`palette-fix-detail ${fix.failed ? 'palette-fix-failed' : ''}`}>{fix.failed ?? fix.detail}</div>}
      <div className="palette-fix-actions">
        {fix.running ? null : (
          <>
            <button type="button" className="palette-fix-button" data-testid="palette-fix-run" onClick={() => void palette.runFix(entry.id)}>
              {fix.label}
            </button>
            <span className="palette-fix-command">{fix.command}</span>
            <button type="button" className="palette-fix-dismiss" data-testid="palette-fix-dismiss" onClick={() => palette.dismissFix(entry.id)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}
