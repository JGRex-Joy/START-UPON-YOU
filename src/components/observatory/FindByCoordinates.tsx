import { useEffect, useRef } from 'react';
import { CoordinateSearch } from '../navigation/CoordinateSearch';
import type { SkyPosition } from '../../types';

/** Floating "Find by Coordinates" control: a compact button that slides a panel over the map (never occupies map space while closed). */
export function FindByCoordinates({ open, onOpenChange, onSubmit, initial }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (pos: SkyPosition) => void;
  initial: SkyPosition | null;
}) {
  const btn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onOpenChange(false); btn.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);
  return (
    <div className="findcoord">
      <button ref={btn} className="findcoord__btn" aria-expanded={open} aria-controls="findcoord-panel" onClick={() => onOpenChange(!open)} data-testid="find-by-coordinates">
        <span aria-hidden="true" className="findcoord__icon">⌖</span> Find by Coordinates
      </button>
      <div id="findcoord-panel" ref={panel} className={`findcoord__panel ${open ? 'is-open' : ''}`} role="region" aria-label="Find by coordinates" aria-hidden={!open} {...(!open ? { inert: '' as unknown as boolean } : {})}>
        <p className="findcoord__lead">Fly the map to any position (ICRS / J2000).</p>
        <CoordinateSearch
          idPrefix="sky" size="compact" allowHours initial={initial} submitLabel="Navigate"
          onSubmit={(p) => { onSubmit(p); onOpenChange(false); }}
        />
      </div>
    </div>
  );
}
