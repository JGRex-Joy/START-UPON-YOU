import { useEffect, useRef, useState, type ReactNode } from 'react';
import { COMPANION_GREETING, ENTRY_TIMING } from '../../app/entry';
import { Bubble } from '../welcome/Bubble';

/**
 * Scene 4's companion: a small Nyan Cat at the edge of the sky. It greets the visitor once the map is up, then settles
 * down and stays out of the way. Clicking it opens the only menu on this screen — everything else the Observatory can
 * do stays one deliberate interaction away, so the sky itself is never covered by a toolbar.
 */
export function NyanCompanion({ mapReady, open, onOpenChange, instant = false, invite, children }: {
  mapReady: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instant?: boolean;
  /** Shown in the same slot once the greeting has gone: the companion's offer to move on. */
  invite?: ReactNode;
  children: ReactNode;
}) {
  const [greeting, setGreeting] = useState(false);
  const greeted = useRef(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  // Once, after the map is actually up (and never while the menu is open).
  useEffect(() => {
    if (!mapReady || greeted.current) return;
    greeted.current = true;
    setGreeting(true);
    const id = window.setTimeout(() => setGreeting(false), ENTRY_TIMING.greeting);
    return () => window.clearTimeout(id);
  }, [mapReady]);

  // Opening the companion reveals the Observatory's controls, so it stays open until it is dismissed on purpose:
  // clicking one of the controls it just revealed — or the sky itself — must not take them away again.
  useEffect(() => {
    if (!open) return;
    setGreeting(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onOpenChange(false); btn.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  return (
    <div className={`companion ${open ? 'is-open' : ''}`} data-testid="companion">
      {greeting && !open && (
        <Bubble text={COMPANION_GREETING} tail="down" instant={instant} speed={22} className="companion__greeting" testId="companion-greeting" />
      )}
      {!greeting && !open && invite}

      <div ref={panel} className="companion__panel" role="group" aria-label="Observatory controls" aria-hidden={!open} {...(!open ? { inert: '' as unknown as boolean } : {})}>
        {children}
      </div>

      <button
        ref={btn} type="button" className="companion__cat" data-testid="companion-button"
        aria-expanded={open} aria-label={open ? 'Hide the Observatory controls' : 'Nyan Cat — show the Observatory controls'}
        onClick={() => onOpenChange(!open)}
      >
        <img src={`${import.meta.env.BASE_URL}nyan-cat.png`} alt="" draggable={false} />
      </button>
    </div>
  );
}
