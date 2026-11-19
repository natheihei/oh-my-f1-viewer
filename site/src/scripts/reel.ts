/**
 * What the page's reels share: the hero, and the jump in #moment. Each tells its story in frames of the app, with
 * prompts typed into a palette (Palette.astro) on an empty screen between them.
 */

export const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A reel's clock. It plays on its own, with a button to pause it, and holds while it's off screen or the tab is hidden.
 * Under reduced motion it starts paused. `what` names the reel for the button's label, as in "Pause the screenshots".
 */
export function clock(reel: HTMLElement, toggle: HTMLButtonElement, what: string) {
  let paused = reduce;
  let visible = true;
  let wake: (() => void) | null = null;
  const running = () => !paused && visible && !document.hidden;
  const resume = () => {
    if (running() && wake) {
      wake();
      wake = null;
    }
  };
  const setPaused = (p: boolean) => {
    paused = p;
    toggle.textContent = p ? 'play' : 'pause';
    toggle.setAttribute('aria-pressed', String(p));
    toggle.setAttribute('aria-label', `${p ? 'Play' : 'Pause'} ${what}`);
    resume();
  };
  toggle.addEventListener('click', () => setPaused(!paused));
  setPaused(paused);
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    resume();
  }).observe(reel);
  document.addEventListener('visibilitychange', resume);

  /** Resolves once it's playing */
  const ready = async () => {
    while (!running()) await new Promise<void>((r) => (wake = r));
  };
  /** Waits, and keeps waiting while it isn't playing */
  const wait = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    await ready();
  };
  return { ready, wait };
}

/** Types a prompt into a reel's palette the way the app shows it, and sends it. */
export function palette(el: HTMLElement, wait: (ms: number) => Promise<void>) {
  const typed = el.querySelector<HTMLElement>('[data-typed]')!;
  const mark = el.querySelector<HTMLElement>('[data-mark]')!;
  const sent = el.querySelector<HTMLElement>('[data-sent]')!;
  return {
    /** Shows the palette empty, types the prompt a key at a time, and presses Enter. Resolves while the "…" pulses */
    async ask(prompt: string) {
      el.classList.remove('sent', 'keys', 'busy', 'asking', 'pressing', 'pressed');
      mark.textContent = '>';
      typed.textContent = '';
      el.classList.add('show');
      await wait(900);
      el.classList.add('keys');
      if (reduce) typed.textContent = prompt;
      else
        for (let n = 1; n <= prompt.length; n++) {
          typed.textContent = prompt.slice(0, n);
          await wait(28 + Math.random() * 45);
        }
      await wait(reduce ? 1200 : 500);
      // Enter: it goes up into the history, and the agent works, with the app's pulsing "…"
      sent.textContent = prompt;
      typed.textContent = '';
      el.classList.remove('keys');
      el.classList.add('sent', 'busy');
      mark.textContent = '…';
      await wait(1500);
    },
    /** The spoiler check comes up, and Allow once is pressed. For a palette drawn with `spoiler` */
    async allow() {
      el.classList.add('asking');
      await wait(2400);
      el.classList.add('pressing');
      await wait(800);
      el.classList.add('pressed');
      await wait(300);
    },
    hide() {
      el.classList.remove('show', 'asking', 'pressing', 'pressed');
    },
  };
}

/** Shows frame i of a reel's frames, fading the others out. -1 shows none: the empty screen */
export const showFrame = (frames: HTMLElement[], i: number) =>
  frames.forEach((f, j) => f.classList.toggle('on', j === i));
