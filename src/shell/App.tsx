import { useEffect, useRef, useState } from 'react';
import { Backdrop, Grid, host, useLive } from '../host';
import { connectAgent } from './agentFeed';
import { CommandPalette } from './CommandPalette';
import { reportReadiness } from './commands';
import { f1tvFix } from './fixes';
import { goHome } from './home';
import { Landing, useLandingShown } from './Landing';
import { lookAhead } from './lookAhead';
import { Onboarding } from './Onboarding';
import { onboarding, useOnboarding } from './onboardingState';
import { palette } from './palette';
import { usePersistBackground } from './persistBackground';
import { usePersistVolume } from './persistVolume';
import { Timeline } from './Timeline';
import { watchUpdates } from './updates';
import { showTelemetryNotice } from './telemetry';

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
      <button type="button" className="countdown-close" data-testid="countdown-close" onClick={() => void goHome()}>
        stop waiting
      </button>
    </div>
  );
}

export function App() {
  const session = useLive((s) => s.session);
  const hasSession = session != null;
  const onboardingActive = useOnboarding((s) => s.active);
  const landingShown = useLandingShown();
  usePersistVolume();
  usePersistBackground();

  // A session opened from the palette while onboarding shows ends it too, as does a countdown starting.
  const opened = useLive((s) => s.session != null || s.countdown != null);
  const wasOpen = useRef(opened);
  useEffect(() => {
    if (opened && !wasOpen.current) onboarding.finish('done');
    wasOpen.current = opened;
  }, [opened]);

  // "Allow for this session" lasts as long as this opening of it. The data layer makes a new one each time.
  useEffect(() => lookAhead.sessionChanged(), [session]);

  useEffect(() => {
    const offAgent = connectAgent();
    const updates = watchUpdates();
    void onboarding.start().then(() => updates.reported).then(reportReadiness).then(showTelemetryNotice);
    const offTiles = host.telemetry.countTiles();
    const offExpired = host.account.onExpired(() => {
      host.session.close();
      palette.show();
      palette.pushFix('F1 TV ended your sign-in.', f1tvFix('expired'));
    });
    return () => {
      offAgent();
      updates.off();
      offExpired();
      offTiles();
    };
  }, []);

  return (
    <div className="app" data-has-session={hasSession}>
      <div className="surface">
        <Backdrop />
        <Grid />
        {onboardingActive && !opened ? <Onboarding /> : null}
        {landingShown ? <Landing /> : null}
        <Countdown />
        <CommandPalette />
      </div>
      <Timeline />
    </div>
  );
}
