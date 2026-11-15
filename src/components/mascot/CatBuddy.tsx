import { useEffect, useState } from 'react';
import type { Route } from '../../app/router';
import { Bubble } from '../welcome/Bubble';

const HINTS: Record<Route, string[]> = {
  missions: ['Pick a mission — each one is a real question about a real object.', 'Motion or variability? Both start with comparing observations.'],
  sky: ['Click a marker, or anywhere on the sky.'],
  explorer: ['Try Compare: two observations side by side tell a story.', 'Spectral shows the same spot in many colours of infrared.'],
  analysis: ['These tools are prototypes — treat what they find as candidates.', 'Done analysing? Head to Submission and write it up!'],
  submit: ['Write what you really saw. Honest notes beat exciting guesses.', 'Not sure? Say so. Uncertainty is part of science.'],
  journal: ['Your investigations live here. Ready for another mission?'],
  landing: ['Nyan! Start with a mission when you are ready.'],
};
const PURR = ['Nyan~!', 'Purr… ✦', 'Hey, that tickles!', '=^.^='];

/** The companion outside the sky map: click for a reaction, double duty as a contextual hint. Cheers on submission. */
export function CatBuddy({ route }: { route: Route }) {
  const [msg, setMsg] = useState('');
  const [hop, setHop] = useState(0);
  const [n, setN] = useState(0);
  const say = (m: string) => { setMsg(m); setHop((h) => h + 1); };
  useEffect(() => { setMsg(''); }, [route]);
  useEffect(() => {
    const on = () => say('You did it! A whole investigation, start to finish. ✦');
    window.addEventListener('suy:submitted', on);
    return () => window.removeEventListener('suy:submitted', on);
  }, []);
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(''), 5200);
    return () => window.clearTimeout(id);
  }, [msg, hop]);
  const click = () => {
    const hints = HINTS[route] ?? [];
    say(n % 3 === 2 ? PURR[Math.floor(Math.random() * PURR.length)] : hints[n % Math.max(1, hints.length)] ?? PURR[0]);
    setN(n + 1);
  };
  return (
    <div className="buddy">
      {msg && <Bubble key={hop} text={msg} tail="down" speed={18} className="buddy__bubble" />}
      <button key={hop} className={`buddy__cat ${hop ? 'is-hop' : ''}`} onClick={click} aria-label="Nyan Cat — click for a hint">
        <img src={`${import.meta.env.BASE_URL}nyan-cat.png`} alt="" draggable={false} />
      </button>
    </div>
  );
}
