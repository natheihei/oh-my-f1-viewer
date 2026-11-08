/**
 * Shows a feed, the way a Herdr mod shows a live terminal. The stream and its element belong to the
 * core: mounting this is what asks for the stream, and unmounting gives it back.
 */
import { useEffect, useRef } from 'react';
import { sessionControl } from '../data/session';

export function Video({ feed, className }: { feed: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handle = sessionControl.acquire(feed);
    const host = hostRef.current;
    if (!handle || !host) return;
    host.appendChild(handle.video);
    const observer = new ResizeObserver(([entry]) => handle.setDisplayHeight(entry.contentRect.height));
    observer.observe(host);
    return () => {
      observer.disconnect();
      sessionControl.release(feed);
    };
  }, [feed]);

  return <div ref={hostRef} className={className} />;
}
