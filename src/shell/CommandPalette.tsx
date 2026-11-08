/**
 * The app's only control surface besides the timeline: an input box, plus a short history box when
 * there is history. Older history is a scroll away. Sits above the timeline, over the video.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sendToAgent } from '../agent/bridge';
import { useSession } from '../data/session';
import { matchCommands, SLASH_COMMANDS } from './commands';
import { palette, usePalette, type EntryRole } from './palette';

const ROLE_PREFIX: Record<EntryRole, string> = {
  user: '> ',
  agent: '',
  system: '# ',
  error: '! ',
};

export function CommandPalette() {
  const { open, busy, entries } = usePalette();
  const blank = useSession((s) => s.session == null);
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const sentRef = useRef<string[]>([]);
  const recallRef = useRef<number | null>(null);

  // With nothing on screen the palette is the whole interface, so it can't be dismissed.
  const showing = open || blank;
  const suggestions = matchCommands(value);

  useEffect(() => {
    if (showing) inputRef.current?.focus();
  }, [showing]);

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

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    setValue('');
    setSelected(0);
    recallRef.current = null;
    sentRef.current.push(text);
    if (text.startsWith('/')) {
      const command = SLASH_COMMANDS.find((c) => c.name === text) ?? suggestions[selected];
      if (command) {
        palette.push('user', command.name);
        void command.run();
      } else {
        palette.push('user', text);
        palette.push('error', `Unknown command. Available: ${SLASH_COMMANDS.map((c) => c.name).join(', ')}`);
      }
      return;
    }
    void sendToAgent(text);
  };

  const recall = (direction: -1 | 1) => {
    const sent = sentRef.current;
    if (sent.length === 0) return;
    const current = recallRef.current ?? sent.length;
    const next = current + direction;
    if (next < 0) return;
    if (next >= sent.length) {
      recallRef.current = null;
      setValue('');
      return;
    }
    recallRef.current = next;
    setValue(sent[next]);
  };

  return (
    <div className="palette" data-testid="palette" onMouseDown={palette.keepOpen}>
      {entries.length > 0 ? (
        <div ref={historyRef} className="palette-history" data-testid="palette-history">
          {entries.map((entry) => (
            <div key={entry.id} className={`palette-line palette-${entry.role}`}>
              {ROLE_PREFIX[entry.role]}
              {entry.text}
            </div>
          ))}
        </div>
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
            </div>
          ))}
        </div>
      ) : null}
      <div className="palette-input-row">
        <span className={`palette-prompt ${busy ? 'palette-prompt-busy' : ''}`}>{busy ? '…' : '>'}</span>
        <input
          ref={inputRef}
          data-testid="palette-input"
          className="palette-input"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={blank ? 'name a session, or / for commands' : 'ask for anything on screen'}
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
              else if (!blank) palette.hide();
            } else if (e.key === 'Tab' && suggestions.length > 0) {
              e.preventDefault();
              setValue(suggestions[selected].name);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (suggestions.length > 0) setSelected((selected + 1) % suggestions.length);
              else recall(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (suggestions.length > 0) setSelected((selected - 1 + suggestions.length) % suggestions.length);
              else recall(-1);
            }
          }}
        />
      </div>
    </div>
  );
}
