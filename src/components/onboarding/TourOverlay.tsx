import { useEffect, useLayoutEffect, useState } from 'react';
import { Bubble } from '../welcome/Bubble';
import { TOUR, TOUR_TEXT, tourStep, type EntryPhase } from '../../app/entry';

/** Pause before each step's instruction (ms). Steps not listed wait 8 s; the very first and the last do not wait. */
const QUIET: Partial<Record<EntryPhase, number>> = {
  sky_map_intro: 0, sky_pick: 6000, sky_open: 2500, onboarding_complete: 0,
};

interface Rect { top: number; left: number; width: number; height: number }

/** Follows the real element (it may appear later, e.g. the inspector after a marker is clicked). null = not on screen. */
function useTarget(selector: string | null, pick: 'first' | 'active' = 'first'): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    setRect(null);
    if (!selector) return;
    const measure = () => {
      const el = document.querySelector(pick === 'active' ? `${selector}.is-active` : selector) ?? document.querySelector(selector);
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect((p) => (p && p.top === r.top && p.left === r.left && p.width === r.width && p.height === r.height ? p : { top: r.top, left: r.left, width: r.width, height: r.height }));
    };
    measure();
    const poll = window.setInterval(measure, 250);
    window.addEventListener('resize', measure);
    return () => { window.clearInterval(poll); window.removeEventListener('resize', measure); };
  }, [selector, pick]);
  return rect;
}

/**
 * The action-based tutorial. Nyan Cat explains, then WAITS: the step only advances when the user really performs the
 * action on the real interface (detected from DOM events). The overlay never intercepts clicks, so nothing is faked.
 */
export function TourOverlay({ phase, onNext, reducedMotion }: {
  phase: EntryPhase;
  onNext: () => void;
  reducedMotion: boolean;
}) {
  const step = tourStep(phase);
  const finishing = phase === 'onboarding_complete';
  const many = step?.selector === '.skymark';
  const rect = useTarget(many ? null : step?.selector ?? null);
  const [hint, setHint] = useState(false);
  // After every action the cat steps back for a few seconds so the user can try what they just opened.
  const quietMs = QUIET[phase] ?? 8000;
  const [quiet, setQuiet] = useState(quietMs > 0);
  useEffect(() => {
    setQuiet(quietMs > 0);
    if (quietMs <= 0) return;
    const id = window.setTimeout(() => setQuiet(false), quietMs);
    return () => window.clearTimeout(id);
  }, [phase, quietMs]);
  const [missing, setMissing] = useState(false);

  // USER ACTS -> APP DETECTS: listen for the real event on the real element.
  useEffect(() => {
    setHint(false);
    setMissing(false);
    if (!step?.act) return;
    const sel = step.selector;
    let moved = false;
    const hit = (e: Event) => !!sel && e.target instanceof Element && !!e.target.closest(sel);
    const onClick = (e: Event) => { if (step.act === 'click' && hit(e)) onNext(); };
    const onInput = (e: Event) => { if (step.act === 'input' && hit(e) && (e.target as HTMLInputElement).value.trim().length >= 3) onNext(); };
    const inMap = (e: Event) => e.target instanceof Element && !!e.target.closest('.skyctx__host');
    const onWheel = (e: Event) => { if (step.act === 'move' && inMap(e)) onNext(); };
    const onDown = (e: Event) => { moved = false; if (step.act === 'move' && inMap(e)) moved = true; };
    const onUp = (e: PointerEvent) => { if (step.act === 'move' && moved && (Math.abs(e.movementX) + Math.abs(e.movementY) >= 0)) { if (dragged) onNext(); } moved = false; dragged = false; };
    let dragged = false;
    const onMove = () => { if (moved) dragged = true; };
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    const hintT = window.setTimeout(() => setHint(true), quietMs + 14000);
    // If the control this step needs is genuinely not on screen (e.g. Analysis tools with no data loaded),
    // say so and offer NEXT rather than trapping the user.
    const missT = window.setTimeout(() => { if (sel && !document.querySelector(sel)) setMissing(true); }, quietMs + 3000);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      window.clearTimeout(hintT); window.clearTimeout(missT);
    };
  }, [phase, step, onNext, quietMs]);

  const text = finishing ? TOUR_TEXT.done : step?.text ?? '';
  const waiting = !!step?.act && !missing;
  const total = TOUR.length + 1;
  const index = finishing ? total : (step ? TOUR.indexOf(step) + 1 : 1);

  // Sit under the highlighted control when there is room; otherwise use the tutorial strip at the bottom centre.
  const anchored = !!rect && rect.top + rect.height + 190 < window.innerHeight && rect.height < 200;
  const style = anchored && rect
    ? { top: `${rect.top + rect.height + 16}px`, left: `${Math.max(12, Math.min(rect.left - 8, window.innerWidth - 392))}px` }
    : undefined;

  if (quiet) {
    return (
      <div className="tour tour--centred tour--quiet" data-testid="tour" data-phase={phase}>
        <div className="tour__box tour__box--quiet">
          <img className="tour__cat" src={`${import.meta.env.BASE_URL}nyan-cat.png`} alt="" draggable={false} />
          <p className="tour__pause">Nice! Take a moment — try it out.</p>
          <button className="tour__ready" data-testid="tour-ready" onClick={() => setQuiet(false)}>I'm ready</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`tour ${anchored ? 'tour--anchored' : 'tour--centred'}`} data-testid="tour" data-phase={phase}>
      {rect && (
        <div className="tour__spot" data-testid="tour-spotlight" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />
      )}
      <div className="tour__box" style={style}>
        <img key={`cat-${phase}`} className="tour__cat" src={`${import.meta.env.BASE_URL}nyan-cat.png`} alt="" draggable={false} />
        <Bubble key={phase} text={text} tail={anchored ? 'up' : 'none'} instant={reducedMotion} speed={16} className="tour__bubble" testId="tour-bubble">
          <span className="tour__count">{index} / {total}</span>
          {waiting
            ? <span className="tour__wait" data-testid="tour-waiting">Your turn</span>
            : <button className="tour__next" data-testid="tour-next" onClick={onNext}>{finishing ? TOUR_TEXT.doneButton : step?.next ?? 'Next'}</button>}
        </Bubble>
        {(hint && waiting && step?.hint) && <p className="tour__hint" data-testid="tour-hint">{step.hint}</p>}
        {missing && <p className="tour__hint">This control is not on screen right now (it needs loaded observations), so you can move on.</p>}
      </div>
    </div>
  );
}
