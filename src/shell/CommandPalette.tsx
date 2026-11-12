/**
 * The app's only control surface besides the timeline: an input box, plus a short history box when
 * there is history, and between them the spoiler check and the agent's suggested tiles. Older history
 * is a scroll away. Sits above the timeline, over the video. It stays open while there are suggestions
 * or a spoiler check.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { host, read, useLive } from '../host';
import { AgentPanel, describeAgent } from './AgentPanel';
import { BackgroundPanel } from './BackgroundPanel';
import { sendToAgent, stopTurn } from './agentFeed';
import { leaveBuild } from './buildMode';
import { matchCommands, parseCommand, reportReadiness, SLASH_COMMANDS } from './commands';
import { lookAhead, sessionAllowed, useLookAhead } from './lookAhead';
import { LookAheadPrompt, type LookAheadPromptHandle } from './LookAheadPrompt';
import { palette, usePalette, type EntryRole } from './palette';
import { SuggestionStrip, type SuggestionStripHandle } from './SuggestionStrip';

/** While the agent is still working, a second Esc this soon after the first stops it. */
const ESC_AGAIN_MS = 2000;

/** The input grows with a long prompt up to this many lines, then scrolls. */
const INPUT_MAX_LINES = 6;

const ROLE_PREFIX: Record<EntryRole, string> = {
  user: '> ',
  agent: '',
  system: '# ',
  error: '! ',
};

export function CommandPalette() {
  const { open, busy, entries, panel } = usePalette();
  const blank = useLive((s) => s.session == null);
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<SuggestionStripHandle | null>(null);
  const promptRef = useRef<LookAheadPromptHandle | null>(null);
  const asking = useLookAhead((s) => s.asking);
  const contentId = useLive((s) => s.session?.contentId ?? null);
  const lookAheadAllowed = useLookAhead((s) => sessionAllowed(s, contentId));
  const tiles = useLive((s) => s.suggestions.items);
  const building = useLive((s) => s.build.active);
  const changeCount = useLive((s) => s.build.changes.length);
  const [armed, setArmed] = useState(false);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // With nothing on screen the palette is the whole interface, so it can't be dismissed.
  const hasTiles = tiles.length > 0;
  // While building, the tag beside the input is the only way out, so the palette stays.
  const showing = open || blank || hasTiles || asking || building || panel != null;
  const suggestions = matchCommands(value);

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

  // The input wraps a long prompt and grows to fit it, up to INPUT_MAX_LINES.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const line = parseFloat(getComputedStyle(input).lineHeight);
    input.style.height = `${Math.min(input.scrollHeight, line * INPUT_MAX_LINES)}px`;
  }, [value, showing, panel]);

  useLayoutEffect(() => {
    const box = historyRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [entries, showing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if (usePalette.getState().open && !blank) palette.hide();
        else palette.show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blank]);

  if (!showing) return null;

  if (panel === 'background') {
    const closePanel = () => {
      palette.closePanel();
      const { style } = read().background;
      palette.push('system', `Background: ${read().backgrounds.find((b) => b.name === style)?.title ?? 'off'}.`);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    return (
      <div className={`palette ${building ? 'palette-building' : ''}`} data-testid="palette" data-building={building} onMouseDown={palette.keepOpen}>
        <BackgroundPanel onClose={closePanel} />
      </div>
    );
  }

  if (panel === 'agent') {
    const closePanel = () => {
      palette.closePanel();
      requestAnimationFrame(() => inputRef.current?.focus());
      void host.agent.status().then((status) => {
        const line = describeAgent(status);
        if (line) palette.push('system', line);
        return reportReadiness();
      });
    };
    return (
      <div className="palette" data-testid="palette" onMouseDown={palette.keepOpen}>
        <AgentPanel onClose={closePanel} />
      </div>
    );
  }

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    setValue('');
    setSelected(0);
    if (text.startsWith('/')) {
      const { name, rest } = parseCommand(text);
      const command = SLASH_COMMANDS.find((c) => c.name === name) ?? (rest ? undefined : suggestions[selected]);
      if (command && (!rest || command.takesText)) {
        palette.push('user', rest ? `${command.name} ${rest}` : command.name);
        void command.run(rest);
      } else {
        palette.push('user', text);
        palette.push('error', `Unknown command. Available: ${SLASH_COMMANDS.map((c) => c.name).join(', ')}`);
      }
      return;
    }
    void sendToAgent(text);
  };

  return (
    <div className={`palette ${building ? 'palette-building' : ''}`} data-testid="palette" data-building={building} onMouseDown={palette.keepOpen}>
      {entries.length > 0 ? (
        <div ref={historyRef} className="palette-history" data-testid="palette-history">
          {entries.map((entry) => (
            <div key={entry.id} className={`palette-line palette-${entry.role}`}>
              {ROLE_PREFIX[entry.role]}
              {entry.text}
              {entry.action ? (
                <>
                  {' '}
                  <button type="button" className="palette-action" data-testid="palette-action" onClick={() => palette.act(entry.id)}>
                    {entry.action.label}
                  </button>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {asking ? <LookAheadPrompt ref={promptRef} /> : null}
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
      {suggestions.length > 0 ? (
        <div className="palette-suggestions" data-testid="palette-suggestions">
          {suggestions.map((command, i) => (
            <div
              key={command.name}
              className={`palette-suggestion ${i === selected ? 'palette-suggestion-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setValue(command.name);
                inputRef.current?.focus();
              }}
            >
              <span>{command.name}</span>
              <span className="palette-suggestion-desc">{command.description}</span>
              {command.warning ? (
                <span className="palette-suggestion-warning" data-testid="command-warning">
                  <span className="spoiler-label">! spoiler</span> {command.warning}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="palette-input-row">
        <span className={`palette-prompt ${busy ? 'palette-prompt-busy' : ''}`}>{busy ? '…' : '>'}</span>
        <textarea
          ref={inputRef}
          data-testid="palette-input"
          className="palette-input"
          rows={1}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={building ? 'ask for a mod, or a change to one' : blank ? 'name a session, or / for commands' : 'ask for anything on screen'}
          onChange={(e) => {
            setValue(e.target.value);
            setSelected(0);
            palette.keepOpen();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
              e.preventDefault();
              if (!blank) palette.hide();
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (value) setValue('');
              else if (hasTiles) escapeTiles();
              else if (!blank && !building) palette.hide();
            } else if (e.key === 'Tab' && suggestions.length > 0) {
              e.preventDefault();
              setValue(suggestions[selected].name);
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
      </div>
    </div>
  );
}
