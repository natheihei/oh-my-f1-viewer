/** The session's transport, fixed at the bottom. It drives the clock, so it controls every stream. */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { host, useLive } from '../host';

function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const SEEK_STEP_SEC = 10;
const VOLUME_STEP = 0.05;

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="timeline-speaker" aria-hidden="true">
      <path d="M2 6v4h3l4 3V3L5 6z" fill="currentColor" />
      {muted ? (
        <path d="M11 6l4 4m0-4l-4 4" stroke="currentColor" fill="none" />
      ) : (
        <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" stroke="currentColor" fill="none" />
      )}
    </svg>
  );
}

export function Timeline() {
  const session = useLive((s) => s.session);
  const clock = useLive((s) => s.clock);
  const volume = useLive((s) => s.volume);
  const audio = useLive((s) => s.audio);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const { start, end } = clock;
  const span = Math.max(end - start, 0);
  const shown = dragTime ?? clock.timeSec;
  const progress = span > 0 ? Math.min(1, Math.max(0, (shown - start) / span)) : 0;

  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      // A focused component that handles a key (e.g. arrows between suggestion cards) claims it.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        host.playback.toggle();
      } else if (e.key === 'ArrowLeft') {
        host.playback.seekBy({ seconds: -SEEK_STEP_SEC });
      } else if (e.key === 'ArrowRight') {
        host.playback.seekBy({ seconds: SEEK_STEP_SEC });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        host.audio.changeVolumeBy({ amount: VOLUME_STEP });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        host.audio.changeVolumeBy({ amount: -VOLUME_STEP });
      } else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        host.audio.toggleMute();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  if (!session) return null;

  const timeAt = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return start;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return start + fraction * span;
  };

  // Live timelines show distance behind the edge, since the DVR window's start means nothing.
  const position = clock.live ? `-${formatTime(Math.max(0, end - shown))}` : formatTime(shown - start);
  const total = clock.live ? '' : formatTime(span);
  const muted = volume === 0 || audio == null;
  const hoverFraction = hoverTime != null && span > 0 ? (hoverTime - start) / span : null;
  // The tip centres on the pointer, but pins to the bar's ends rather than leave the window.
  const tipShift = hoverFraction == null ? 0 : hoverFraction < 0.04 ? 0 : hoverFraction > 0.96 ? -100 : -50;

  return (
    <div className="timeline" data-testid="timeline">
      <button
        type="button"
        className="timeline-button timeline-play"
        data-testid="timeline-play"
        aria-label={clock.playing ? 'Pause' : 'Play'}
        onClick={() => host.playback.toggle()}
      >
        <PlayGlyph playing={clock.playing} />
      </button>
      <span className="timeline-title" data-testid="session-title" title={session.title}>
        {session.title}
        {session.year && !session.title.includes(String(session.year)) ? <span className="timeline-total"> {session.year}</span> : null}
      </span>
      <div
        ref={barRef}
        className="timeline-bar"
        data-testid="timeline-bar"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragTime(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          setHoverTime(timeAt(e.clientX));
          if (dragTime != null) setDragTime(timeAt(e.clientX));
        }}
        onPointerUp={(e) => {
          if (dragTime != null) host.playback.seek({ time: timeAt(e.clientX) });
          setDragTime(null);
        }}
        onPointerLeave={() => setHoverTime(null)}
      >
        <div className="timeline-track" />
        {clock.live ? null : <Ticks span={span} />}
        <div className="timeline-fill" style={{ width: `${progress * 100}%` }} />
        {hoverFraction != null ? <div className="timeline-hover-mark" style={{ left: `${hoverFraction * 100}%` }} /> : null}
        <div className="timeline-head" style={{ left: `${progress * 100}%` }} />
        {hoverFraction != null && hoverTime != null ? (
          <div className="timeline-hover" style={{ left: `${hoverFraction * 100}%`, transform: `translateX(${tipShift}%)` }}>
            {clock.live ? `-${formatTime(end - hoverTime)}` : formatTime(hoverTime - start)}
          </div>
        ) : null}
      </div>
      <div className="timeline-time" data-testid="timeline-time">
        {position}
        {total ? <span className="timeline-total"> / {total}</span> : null}
      </div>
      {clock.buffering ? <span className="timeline-tag">buffering</span> : null}
      {clock.live ? (
        <button
          type="button"
          className={`timeline-tag timeline-live ${clock.atLiveEdge ? 'timeline-live-on' : ''}`}
          onClick={() => host.playback.goLive()}
        >
          live
        </button>
      ) : null}
      <div className="timeline-volume">
        <button
          type="button"
          className="timeline-button"
          data-testid="timeline-mute"
          aria-label={muted ? 'Unmute' : 'Mute'}
          // Focus stays out of the control, so Space and the arrows keep driving playback after a click.
          onPointerUp={(e) => e.currentTarget.blur()}
          onClick={() => host.audio.toggleMute()}
        >
          <SpeakerIcon muted={muted} />
        </button>
        <input
          type="range"
          className="timeline-volume-slider"
          data-testid="timeline-volume"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          style={{ '--level': `${volume * 100}%` } as CSSProperties}
          onChange={(e) => host.audio.setVolume({ volume: Number(e.target.value) })}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerUp={(e) => e.currentTarget.blur()}
        />
        <span className="timeline-volume-value">{muted ? 'mute' : String(Math.round(volume * 100))}</span>
      </div>
    </div>
  );
}

function PlayGlyph({ playing }: { playing: boolean }) {
  return (
    <svg viewBox="0 0 10 10" className="timeline-glyph" aria-hidden="true">
      {playing ? <path d="M1 1h3v8H1zM6 1h3v8H6z" fill="currentColor" /> : <path d="M1.5 0.5v9l8-4.5z" fill="currentColor" />}
    </svg>
  );
}

/** Neutral marks along the bar every 15 minutes (5 in a short session), longer on the hour. Nothing from the race. */
function Ticks({ span }: { span: number }) {
  if (span <= 0) return null;
  const step = span > 3600 ? 900 : 300;
  const marks: { at: number; major: boolean }[] = [];
  for (let t = step; t < span; t += step) marks.push({ at: t / span, major: t % 3600 === 0 });
  return (
    <div className="timeline-ticks" aria-hidden>
      {marks.map((m) => (
        <span key={m.at} className={`timeline-tick ${m.major ? 'timeline-tick-major' : ''}`} style={{ left: `${m.at * 100}%` }} />
      ))}
    </div>
  );
}
