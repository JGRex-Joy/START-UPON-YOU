import { useEffect, useRef, useState } from 'react';

const asset = (name: string) => `${import.meta.env.BASE_URL}${name}`;

/** The supplied Nyan Cat sprite (cat + rainbow trail), with a lightweight stepped CSS bob. */
export function NyanCat({ height = 32, bob = true, className = '' }: { height?: number; bob?: boolean; className?: string }) {
  return (
    <img
      src={asset('nyan-full.png')}
      alt="Nyan Cat, the unofficial mascot"
      height={height}
      className={`nyan ${bob ? 'nyan--bob' : ''} ${className}`}
      style={{ height, width: 'auto', imageRendering: 'pixelated' }}
      draggable={false}
    />
  );
}

/** Nyan Cat crossing a lane once, repeating every `every` seconds. Decorative; never intercepts pointer events. */
export function NyanTraveler({ height = 40, every = 22, className = '' }: { height?: number; every?: number; className?: string }) {
  return (
    <div className={`nyan-lane ${className}`} aria-hidden="true">
      <div className="nyan-lane__runner" style={{ animationDuration: `${every}s` }}>
        <NyanCat height={height} />
      </div>
    </div>
  );
}

/** Full-width one-shot flight used by the easter egg. */
export function NyanFlight({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 5200);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="nyan-flight" aria-hidden="true">
      <div className="nyan-flight__runner">
        <NyanCat height={64} />
      </div>
    </div>
  );
}

/** Small contextual appearance, e.g. when candidate sources are found. */
export function NyanToast({ trigger, message }: { trigger: number; message: string }) {
  const [visible, setVisible] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; if (trigger === 0) return; }
    if (trigger === 0) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 4200);
    return () => clearTimeout(t);
  }, [trigger]);
  if (!visible) return null;
  return (
    <div className="nyan-toast" role="status">
      <NyanCat height={26} />
      <span>{message}</span>
    </div>
  );
}

/** Loading indicator with a tiny Nyan Cat companion. */
export function NyanLoader({ label }: { label: string }) {
  return (
    <div className="loader" role="status" aria-live="polite">
      <div className="loader__track"><div className="loader__cat"><NyanCat height={22} /></div></div>
      <span className="loader__label">{label}</span>
    </div>
  );
}

/** Triggers on typing "nyan" (outside form fields) or via the returned `fire()` (e.g. logo clicked 5×). */
export function useNyanEasterEgg(): { flights: number; fire: () => void } {
  const [flights, setFlights] = useState(0);
  const buf = useRef('');
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key.length !== 1) return;
      buf.current = (buf.current + e.key.toLowerCase()).slice(-4);
      if (buf.current === 'nyan') { buf.current = ''; setFlights((n) => n + 1); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return { flights, fire: () => setFlights((n) => n + 1) };
}
