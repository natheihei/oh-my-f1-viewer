/** The session's transport, fixed at the bottom. It drives the clock, so it controls every stream. */
import { useEffect, useRef, useState } from 'react';
import { host, useLive } from '../host';

function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const SEEK_STEP_SEC = 10;

export function Timeline() {
  const session = useLive((s) => s.session);
  const clock = useLive((s) => s.clock);
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
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        host.playback.toggle();
      } else if (e.key === 'ArrowLeft') {
        host.playback.seekBy({ seconds: -SEEK_STEP_SEC });
      } else if (e.key === 'ArrowRight') {
        host.playback.seekBy({ seconds: SEEK_STEP_SEC });
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

  return (
    <div className="timeline" data-testid="timeline">
      <button
        type="button"
        className="timeline-button"
        data-testid="timeline-play"
        aria-label={clock.playing ? 'Pause' : 'Play'}
        onClick={() => host.playback.toggle()}
      >
        {clock.playing ? '❚❚' : '▶'}
      </button>
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
        <div className="timeline-fill" style={{ width: `${progress * 100}%` }} />
        <div className="timeline-head" style={{ left: `${progress * 100}%` }} />
        {hoverTime != null && span > 0 ? (
          <div className="timeline-hover" style={{ left: `${((hoverTime - start) / span) * 100}%` }}>
            {clock.live ? `-${formatTime(end - hoverTime)}` : formatTime(hoverTime - start)}
          </div>
        ) : null}
      </div>
      <div className="timeline-time" data-testid="timeline-time">
        {position}
        {total ? <span className="timeline-total"> / {total}</span> : null}
      </div>
      {clock.buffering ? <div className="timeline-status">buffering</div> : null}
      {clock.live ? (
        <button
          type="button"
          className={`timeline-live ${clock.atLiveEdge ? 'timeline-live-on' : ''}`}
          onClick={() => host.playback.goLive()}
        >
          ● LIVE
        </button>
      ) : null}
    </div>
  );
}
