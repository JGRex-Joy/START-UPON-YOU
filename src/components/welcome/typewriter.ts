import { useEffect, useRef, useState } from 'react';

/* ---------- 8-bit typing blips (Web Audio, no assets, no dependency) ---------- */

let ctx: AudioContext | null = null;
let muted = (() => { try { return localStorage.getItem('suy.sound') === 'off'; } catch { return false; } })();

export function isMuted(): boolean { return muted; }
export function setMuted(v: boolean): void {
  muted = v;
  try { localStorage.setItem('suy.sound', v ? 'off' : 'on'); } catch { /* private mode */ }
}

/** Browsers block audio until a gesture: call this from a click/keydown handler. Never throws. */
export function primeAudio(): void {
  if (muted || ctx) return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    void ctx.resume?.();
  } catch { ctx = null; }
}

/** One short square-wave click, pitch jittered so a sentence does not sound robotic. Silent if audio is unavailable. */
export function blip(): void {
  if (muted || !ctx || ctx.state !== 'running') return;
  try {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 620 + Math.random() * 260;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.035, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  } catch { /* audio is a garnish, never a failure */ }
}

/* ---------- the typewriter itself ---------- */

/** Pauses (ms) after punctuation, so the cat sounds like it is speaking rather than streaming. */
const PAUSE: Record<string, number> = { '.': 260, '?': 300, '!': 300, ',': 140, ';': 160, ':': 160 };

export interface TypewriterOptions {
  /** Average milliseconds per character. */
  speed?: number;
  /** Skip the animation entirely (reduced motion). */
  instant?: boolean;
  /** Play a blip roughly every N characters. */
  soundEvery?: number;
}

/**
 * Reveals `text` one character at a time on a wall-clock schedule (so a slow machine does not slow the speech down),
 * with a little random jitter and a pause after punctuation. Returns the visible text and a `skip()`.
 */
export function useTypewriter(text: string, { speed = 32, instant = false, soundEvery = 2 }: TypewriterOptions = {}) {
  const [shown, setShown] = useState(instant ? text.length : 0);
  const skipped = useRef(false);

  useEffect(() => {
    skipped.current = false;
    if (instant) { setShown(text.length); return; }
    setShown(0);
    // Pre-compute when each character is due; jitter and punctuation pauses are baked into the schedule.
    const due: number[] = [];
    let t = 0;
    for (let i = 0; i < text.length; i++) {
      t += speed * (0.7 + Math.random() * 0.6);
      t += PAUSE[text[i]] ?? 0;
      due.push(t);
    }
    const started = performance.now();
    let raf = 0;
    let spoken = 0;
    const step = (now: number) => {
      if (skipped.current) return;
      const elapsed = now - started;
      let n = shownFor(due, elapsed);
      if (n > spoken) {
        if (Math.floor(n / soundEvery) !== Math.floor(spoken / soundEvery)) blip();
        spoken = n;
      }
      setShown(n);
      if (n < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, speed, instant, soundEvery]);

  return {
    shown: text.slice(0, shown),
    done: shown >= text.length,
    skip: () => { skipped.current = true; setShown(text.length); },
  };
}

function shownFor(due: number[], elapsed: number): number {
  let lo = 0;
  let hi = due.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (due[mid] <= elapsed) lo = mid + 1; else hi = mid;
  }
  return lo;
}
