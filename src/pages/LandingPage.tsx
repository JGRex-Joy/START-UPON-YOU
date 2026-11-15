import { useStore } from '../app/store';
import { CoordinateSearch } from '../components/navigation/CoordinateSearch';
import { SkyContext } from '../components/sky/SkyContext';
import { NyanTraveler } from '../components/mascot/NyanCat';
import { CHALLENGE_TARGETS } from '../services/targets';
import type { SkyPosition } from '../types';

const FACTS = [
  { k: '0.75–5 µm', v: 'Near-infrared coverage, in 102 spectral channels' },
  { k: '4 × all-sky', v: 'Passes of the whole sky during the two-year prime mission' },
  { k: '6 detectors', v: 'Each exposure samples one wavelength range per detector' },
  { k: 'Open data', v: 'Spectral images are public through NASA/IPAC IRSA' },
];

const WISE_0855: SkyPosition = { ra: 133.795129, dec: -7.245147 };

export function LandingPage({ onExplore }: { onExplore: () => void }) {
  const { state, actions } = useStore();
  const explore = (p: SkyPosition, name?: string) => { void actions.search(p, name); onExplore(); };
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">NASA SPHEREx · Space Apps Challenge</p>
          <h1 className="hero__title">STARS UPON YOU<span className="hero__dot">.</span></h1>
          <p className="hero__tag">Look beyond what meets the eye.</p>
          <p className="hero__desc">
            Explore the infrared universe through time. Investigate astronomical observations, compare spectral information, and discover what changes in the night sky.
          </p>
          <div className="hero__search">
            <CoordinateSearch idPrefix="lp" size="large" initial={null} busy={state.phase === 'searching'} onSubmit={(p) => explore(p)} />
          </div>
          <div className="hero__quick" aria-label="Challenge targets">
            <span className="dim">Or begin with</span>
            {CHALLENGE_TARGETS.map((t) => (
              <button key={t.id} className="chip" onClick={() => { void actions.search({ ra: t.ra, dec: t.dec }, t.name, t); onExplore(); }}>{t.name}</button>
            ))}
          </div>
          <p className="hero__demo"><button className="linkbtn" onClick={() => { actions.startDemo(); onExplore(); }}>No archive access? Open the labelled demo →</button></p>
        </div>
        <div className="hero__plate" aria-label="Sky preview">
          <SkyContext position={WISE_0855} fovDeg={0.5} compact />
          <NyanTraveler className="hero__nyan" height={38} every={20} />
        </div>
      </section>

      <section className="facts" aria-label="About SPHEREx">
        {FACTS.map((f) => (
          <div key={f.k} className="fact">
            <div className="fact__k">{f.k}</div>
            <div className="fact__v">{f.v}</div>
          </div>
        ))}
      </section>

      <section className="honesty">
        <h2 className="display display--sm">What you are looking at</h2>
        <div className="honesty__grid">
          <p><strong>Epochs are not channels.</strong> The timeline shows real observation times of individual exposures. The 102 spectral channels sample wavelength, never time.</p>
          <p><strong>Every number has a source.</strong> Dates come from the archive; missing data is shown as missing, never as zero. Synthetic demo data is always labelled.</p>
          <p><strong>Candidates, not discoveries.</strong> Source detection, subtraction and tracking are prototypes that produce <em>potential</em> sources and changes for follow-up.</p>
        </div>
      </section>
      <footer className="footer mono">
        Preview: DSS2 optical survey via CDS Aladin Lite (context imagery, not SPHEREx). SPHEREx data: NASA/IPAC Infrared Science Archive.
      </footer>
    </div>
  );
}
