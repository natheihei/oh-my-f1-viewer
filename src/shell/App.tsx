import { useEffect, useState } from 'react';
import { Grid, host, useLive } from '../host';
import { connectAgent } from './agentFeed';
import { CommandPalette } from './CommandPalette';
import { reportReadiness } from './commands';
import { palette } from './palette';
import { Timeline } from './Timeline';

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

function Countdown() {
  const countdown = useLive((s) => s.countdown);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!countdown) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [countdown]);
  if (!countdown) return null;
  const remaining = countdown.startMs - now;
  return (
    <div className="countdown" data-testid="countdown">
      <div className="countdown-title">{countdown.title}</div>
      <div className="countdown-time">{remaining > 0 ? formatRemaining(remaining) : 'waiting for F1 TV to go live…'}</div>
    </div>
  );
}

export function App() {
  const hasSession = useLive((s) => s.session != null);

  useEffect(() => {
    const offAgent = connectAgent();
    void reportReadiness();
    const offExpired = host.account.onExpired(() => {
      host.session.close();
      palette.show();
      palette.push('error', 'F1 TV session expired. Run /login-f1tv.');
    });
    return () => {
      offAgent();
      offExpired();
    };
  }, []);

  return (
    <div className="app" data-has-session={hasSession}>
      <div className="surface">
        <Grid />
        <Countdown />
        <CommandPalette />
      </div>
      <Timeline />
    </div>
  );
}
