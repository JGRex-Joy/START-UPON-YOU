import { useRef } from 'react';
import type { Route } from '../../app/router';
import { useStore } from '../../app/store';
import { forgetEntered } from '../../app/entry';

const LINKS: { route: Route; label: string }[] = [
  { route: 'missions', label: 'Missions' },
  { route: 'sky', label: 'Sky Map' },
  { route: 'explorer', label: 'Explorer' },
  { route: 'analysis', label: 'Analysis' },
  { route: 'submit', label: 'Submission' },
  { route: 'journal', label: 'Journal' },
];
/** Destinations that do not exist yet. Shown so the product shape is visible, but never clickable and never faked. */
const COMING: string[] = ['Field Guide'];

export function OriginBadge() {
  const { state } = useStore();
  const o = state.dataset?.origin;
  if (!o) return <span className="badge badge--idle">NO DATA LOADED</span>;
  if (o === 'demo') return <span className="badge badge--demo" title="Synthetic data generated in the browser. Not a NASA observation.">DEMO · SYNTHETIC</span>;
  if (o === 'user-file') return <span className="badge badge--file">YOUR FITS FILE</span>;
  return <span className="badge badge--live" title="Retrieved from NASA/IPAC IRSA">SPHEREx · IRSA</span>;
}

export function AppNav({ route, go, onLogoBurst, locked = false, allow = null }: { route: Route; go: (r: Route) => void; onLogoBurst: () => void; locked?: boolean; allow?: string | null }) {
  const clicks = useRef<number[]>([]);
  const logoClick = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 1800), now];
    if (clicks.current.length >= 5) { clicks.current = []; onLogoBurst(); }
    if (!locked) go('sky');
  };
  return (
    <header className="nav">
      <button className="nav__brand" onClick={logoClick} aria-label="STARS UPON YOU. — home">
        <span className="nav__wordmark"><i className="nav__spark" aria-hidden="true">✦</i>STARS <em>UPON</em> YOU<span className="nav__dot">.</span></span>
      </button>
      <nav className="nav__links" aria-label="Primary">
        {LINKS.map((l, i) => (
          <button
            key={l.route} className={`nav__link ${route === l.route ? 'is-active' : ''} ${locked ? 'is-locked' : ''} ${allow === l.route ? 'is-next' : ''}`}
            aria-current={route === l.route ? 'page' : undefined} data-route={l.route} aria-disabled={locked && route !== l.route && allow !== l.route}
            title={locked ? 'Available once Nyan Cat has shown you around' : undefined}
            onClick={() => { if (!locked) go(l.route); }}
          >
            <span className="nav__step">{i + 1}</span>{l.label}
          </button>
        ))}
        {locked
          ? <span className="nav__guide">Guided tour</span>
          : <>
              {COMING.map((label) => (
                <span key={label} className="nav__link nav__link--soon" aria-disabled="true" title={`${label} is not available yet`}>{label}<span className="tag">soon</span></span>
              ))}
              <button className={`nav__link nav__link--about ${route === 'landing' ? 'is-active' : ''}`} aria-current={route === 'landing' ? 'page' : undefined} onClick={() => go('landing')}>About</button>
            </>}
      </nav>
      <div className="nav__right">
        {!locked && <button className="nav__link nav__replay" data-testid="replay-tutorial" title="Run Nyan Cat's guided tutorial again" onClick={() => { forgetEntered(); window.location.hash = '#/'; window.location.reload(); }}>? Tutorial</button>}
        <OriginBadge />
      </div>
    </header>
  );
}
