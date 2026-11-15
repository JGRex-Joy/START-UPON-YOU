import { useCallback, useEffect, useRef, useState } from 'react';
import { ENTRY_TIMING, WELCOME_BUTTON, WELCOME_DIALOGUE, type EntryPhase } from '../../app/entry';
import { StarField } from './StarField';
import { Bubble } from './Bubble';
import { primeAudio } from './typewriter';

/**
 * Where the cat's own centre sits inside nyan-full.png (343×93): the rainbow fills the left side, the cat the right.
 * Waypoints are the cat's position, not the sprite box's, so the cat itself never leaves the screen.
 */
const CAT_CENTRE = 0.786;
/** Half the cat's own width, as a fraction of the sprite box — used to keep it clear of the edges. */
const CAT_HALF = 0.23;
const EDGE = 16;
/** The cat tilts into its direction of travel, but never so far that it stops reading as Nyan Cat. */
const MAX_TILT = 16;

interface Point { x: number; y: number }

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A loose tour of the corners: shuffled, jittered, never the same twice, never the same corner back to back. */
function waypoints(vw: number, vh: number, w: number, h: number): Point[] {
  const minX = w * CAT_HALF + EDGE;
  const maxX = vw - w * CAT_HALF - EDGE;
  const minY = h / 2 + EDGE;
  const maxY = vh - h / 2 - EDGE;
  const corner = (cx: number, cy: number): Point => ({
    x: clamp(cx < 0.5 ? rnd(minX, minX + (maxX - minX) * 0.3) : rnd(maxX - (maxX - minX) * 0.3, maxX), minX, maxX),
    y: clamp(cy < 0.5 ? rnd(minY, minY + (maxY - minY) * 0.28) : rnd(maxY - (maxY - minY) * 0.28, maxY), minY, maxY),
  });
  const corners: [number, number][] = [[0, 0], [1, 1], [0, 1], [1, 0], [1, 1], [0, 0], [1, 0], [0, 1], [Math.random(), Math.random()]];
  for (let i = 7; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [corners[i], corners[j]] = [corners[j], corners[i]];
  }
  // A mid-point between consecutive corners bends each leg, so the path curves instead of running corner to corner.
  return corners.map(([cx, cy]) => corner(cx, cy));
}

/** Scenes 1–3. The parent owns the phase; this component drives the timing and reports each step back. */
export function WelcomeScene({ phase, onAdvance, reducedMotion }: {
  phase: EntryPhase;
  onAdvance: (next: EntryPhase) => void;
  reducedMotion: boolean;
}) {
  const lane = useRef<HTMLDivElement | null>(null);
  const tilt = useRef<HTMLDivElement | null>(null);
  const nyan = useRef<HTMLDivElement | null>(null);
  const sprite = useRef<HTMLImageElement | null>(null);
  const here = useRef<Point>({ x: -400, y: 0 });
  const [settled, setSettled] = useState(reducedMotion);
  const [buttonIn, setButtonIn] = useState(false);
  const skip = useRef<(() => void) | null>(null);

  /** Move the cat's centre to `p` over `ms`, tilting and turning to face the way it is going. */
  const fly = useCallback((p: Point, ms: number, ease: string) => {
    const el = lane.current;
    const box = sprite.current;
    if (!el || !box) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const dx = p.x - here.current.x;
    const dy = p.y - here.current.y;
    here.current = p;
    el.style.transition = ms > 0 ? `transform ${ms}ms ${ease}` : 'none';
    el.style.transform = `translate3d(${(p.x - CAT_CENTRE * w).toFixed(1)}px, ${(p.y - h / 2).toFixed(1)}px, 0)`;
    if (ms > 0 && (dx || dy)) {
      const flip = dx < 0 ? -1 : 1;
      const dir = (Math.atan2(dy, dx) * 180) / Math.PI;
      const angle = flip === 1 ? dir : ((dir - 180 + 540) % 360) - 180;
      if (tilt.current) tilt.current.style.transform = `rotate(${clamp(angle, -MAX_TILT, MAX_TILT).toFixed(1)}deg)`;
      if (nyan.current) nyan.current.style.transform = `scaleX(${flip})`;
    }
  }, []);

  const level = useCallback(() => {
    if (tilt.current) tilt.current.style.transform = 'rotate(0deg)';
    if (nyan.current) nyan.current.style.transform = 'scaleX(1)';
  }, []);

  // ---- Scene 1: a playful tour of the screen, then a dash to the middle and a skidding stop.
  useEffect(() => {
    if (phase !== 'welcome_flying') return;
    const box = sprite.current;
    if (!lane.current || !box) return;
    const timers: number[] = [];
    let raf = 0;
    const after = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)); };
    const clear = () => { timers.forEach(clearTimeout); timers.length = 0; cancelAnimationFrame(raf); };

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const centre: Point = { x: vw / 2, y: vh * 0.42 };

    /** The cinematic ending: accelerate, overshoot the middle a little, then brake back into it. */
    const arrive = (dash: number) => {
      clear();
      setSettled(true);
      const from = here.current;
      const over = {
        x: clamp(centre.x + Math.sign(centre.x - from.x || 1) * 52, w * CAT_HALF + EDGE, vw - w * CAT_HALF - EDGE),
        y: clamp(centre.y + Math.sign(centre.y - from.y || 1) * 16, h / 2 + EDGE, vh - h / 2 - EDGE),
      };
      fly(over, dash, 'cubic-bezier(.7,0,.9,.4)');               // sudden acceleration
      after(dash, () => { fly(centre, ENTRY_TIMING.brake, 'cubic-bezier(.2,1.5,.5,1)'); level(); });  // playful brake
      after(dash + ENTRY_TIMING.brake, () => onAdvance('welcome_dialogue'));
    };

    if (reducedMotion) {
      here.current = { x: centre.x + 1, y: centre.y };
      fly(centre, 0, '');
      level();
      after(ENTRY_TIMING.calmSettle, () => onAdvance('welcome_dialogue'));
    } else {
      const route = waypoints(vw, vh, w, h);
      here.current = { x: -w, y: rnd(vh * 0.3, vh * 0.6) };
      fly(here.current, 0, '');
      // Every leg eases out of the previous one and into the next, so the path reads as one continuous curve.
      const eases = ['cubic-bezier(.33,.02,.35,1)', 'cubic-bezier(.4,0,.3,1)', 'cubic-bezier(.3,.05,.4,1)', 'cubic-bezier(.35,0,.3,1)', 'cubic-bezier(.4,.05,.35,1)'];
      let t = 40;
      raf = requestAnimationFrame(() => {
        route.forEach((p, i) => {
          const ms = Math.round(rnd(ENTRY_TIMING.legMin, ENTRY_TIMING.legMax) * (i % 3 === 0 ? 1.25 : 1));
          after(t, () => fly(p, ms, eases[i % eases.length]));
          t += ms;
        });
        after(t, () => arrive(ENTRY_TIMING.dash));
      });
      skip.current = () => arrive(420);
    }

    return () => { clear(); skip.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reducedMotion]);

  // ---- Scene 3: off it goes, and the universe it was waiting to show comes through.
  useEffect(() => {
    if (phase !== 'entering_universe') return;
    setSettled(false);
    const box = sprite.current;
    const w = box?.offsetWidth ?? 260;
    fly({ x: window.innerWidth + w, y: here.current.y - 40 }, ENTRY_TIMING.exit, 'cubic-bezier(.5,0,.85,.4)');
    const id = window.setTimeout(() => onAdvance('exploring'), ENTRY_TIMING.exit);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Little sparkles shed along the path while it flies (a few short-lived DOM nodes, none under reduced motion).
  useEffect(() => {
    if (phase !== 'welcome_flying' || reducedMotion) return;
    const host = lane.current?.parentElement;
    const id = window.setInterval(() => {
      const r = sprite.current?.getBoundingClientRect();
      if (!host || !r || r.right < 0) return;
      const s = document.createElement('i');
      s.className = 'sparkle';
      s.textContent = Math.random() < 0.5 ? '✦' : '✧';
      s.style.left = `${r.left + r.width * (0.3 + Math.random() * 0.4)}px`;
      s.style.top = `${r.top + r.height * (0.2 + Math.random() * 0.7)}px`;
      s.style.color = ['#f2a8ce', '#d3e97a', '#8edbc5', '#b6d0f2', '#fcfd06'][Math.floor(Math.random() * 5)];
      host.appendChild(s);
      window.setTimeout(() => s.remove(), 900);
    }, 55);
    return () => window.clearInterval(id);
  }, [phase, reducedMotion]);

  // A click or a key anywhere hurries the flight along; nothing is skipped past the button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.key === 'Shift') return;
      primeAudio();
      skip.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const speaking = phase === 'welcome_dialogue';
  const leaving = phase === 'entering_universe';

  return (
    <section
      className={`welcome ${leaving ? 'is-leaving' : ''}`}
      data-testid="welcome"
      data-phase={phase}
      aria-label="Welcome to STARS UPON YOU."
      onClick={() => { primeAudio(); skip.current?.(); }}
    >
      <StarField />

      <div className="welcome__lane" ref={lane}>
        <div className="welcome__tilt" ref={tilt}>
          <div className="welcome__nyan" ref={nyan}>
            <span className={`welcome__trail ${settled ? 'is-settled' : ''}`} aria-hidden="true" />
            <img
              ref={sprite} src={`${import.meta.env.BASE_URL}nyan-full.png`} alt="Nyan Cat"
              className="welcome__sprite" draggable={false} data-testid="welcome-nyan"
            />
          </div>
        </div>
      </div>

      {speaking && (
        <div className="welcome__talk">
          <Bubble
            text={WELCOME_DIALOGUE} tail="up" instant={reducedMotion} testId="welcome-dialogue"
            onDone={() => window.setTimeout(() => setButtonIn(true), ENTRY_TIMING.buttonDelay)}
          />
          {buttonIn && (
            <button className="arcade" data-testid="start-exploring" onClick={(e) => { e.stopPropagation(); onAdvance('entering_universe'); }}>
              {WELCOME_BUTTON}
            </button>
          )}
        </div>
      )}

      <button className="sr-only" onClick={(e) => { e.stopPropagation(); onAdvance('entering_universe'); }}>
        Skip the introduction and open the sky map
      </button>
    </section>
  );
}
