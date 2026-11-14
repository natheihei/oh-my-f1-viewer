/**
 * The tiles' errors the viewer attached to their next message, above the palette's input. Each is a tag
 * naming the tile as its title bar does; × takes one out. The message takes them all, with or without
 * words. In the history, a sent line draws the same tags before its text.
 */
import type { ReactNode } from 'react';
import { formatClock } from '../agent/tools';
import { host, type Attachment } from '../host';
import type { AttachedTag } from './palette';

/** A tile as an attachment names it: its id, then its label. */
export function AttachTag({ tag, children }: { tag: AttachedTag; children?: ReactNode }) {
  return (
    <span className="attach-tag" data-testid="attach-tag">
      <span className="attach-tag-id">{tag.scope}</span>
      {tag.label}
      {children}
    </span>
  );
}

/** What's wrong, in a few words: when it threw, or what it needs. */
function what({ report: { place } }: Attachment): string {
  if (place.state === 'error') return place.since ? `error at ${formatClock(place.since.clockSec)}` : 'error';
  return place.missing.length ? `needs ${place.missing.join(', ')}` : "props don't fit";
}

export function AttachTray({ attached, busy }: { attached: Attachment[]; busy: boolean }) {
  return (
    <>
      <div className="attach-tray" data-testid="attach-tray">
        <span className="attach-tray-label">Attached</span>
        {attached.map((a) => (
          <AttachTag key={a.scope} tag={{ scope: a.scope, label: a.report.place.label }}>
            <span className="attach-tag-what">· {what(a)}</span>
            <button
              type="button"
              className="attach-tag-remove"
              data-testid="attach-remove"
              title="Don't send this one"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => host.health.detach({ scope: a.scope })}
            >
              ×
            </button>
          </AttachTag>
        ))}
      </div>
      <div className="strip-hint" data-testid="attach-hint">
        {busy ? 'enter sends now and steers the agent · or wait for it to finish' : 'enter send · type to say more · × remove'}
      </div>
    </>
  );
}
