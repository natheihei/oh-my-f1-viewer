/**
 * Shows a feed, the way a Herdr mod shows a live terminal. The stream and its element belong to the
 * core: mounting this is what asks for the stream, and unmounting gives it back. Inside a
 * `PreviewScope` the hold is quiet, so a preview never makes its feed audible.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { sessionControl } from '../data/session';

const Preview = createContext(false);

/** Marks what's inside as a preview: it shows feeds without taking their audio. */
export function PreviewScope({ children }: { children: ReactNode }) {
  return <Preview.Provider value={true}>{children}</Preview.Provider>;
}

export function Video({ feed, className }: { feed: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const quiet = useContext(Preview);

  useEffect(() => {
    const handle = sessionControl.acquire(feed, { quiet });
    const host = hostRef.current;
    if (!handle || !host) return;
    // Moving the element from another holder keeps it playing.
    host.appendChild(handle.video);
    const observer = new ResizeObserver(([entry]) => handle.setDisplayHeight(entry.contentRect.height));
    observer.observe(host);
    return () => {
      observer.disconnect();
      sessionControl.release(feed, { quiet });
    };
  }, [feed, quiet]);

  return <div ref={hostRef} className={className} />;
}
