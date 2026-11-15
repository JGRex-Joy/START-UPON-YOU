import { useEffect, useMemo } from 'react';
import { useStore } from '../../app/store';
import { Term } from '../layout/Term';
import type { SpectralCube } from '../../types';

/** Mean of the central 5×5 block of a slice — an uncalibrated quick-look, not a spectrum extraction. */
function centreMean(cube: SpectralCube, k: number): number | null {
  if (cube.blankChannels?.includes(k)) return null; // blank channel: never plotted as zero flux
  if (cube.lazy && !cube.lazy.isLoaded(k)) return null; // not fetched yet
  const s = cube.readSlice(k);
  const cx = Math.floor(cube.width / 2);
  const cy = Math.floor(cube.height / 2);
  let sum = 0;
  let n = 0;
  for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
    const v = s[y * cube.width + x];
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : null;
}

export function ChannelSelector() {
  const { state, actions } = useStore();
  const cube = state.dataset?.cube ?? null;
  const info = state.dataset?.cubeInfo ?? null;
  const ch = state.channel;
  const blank = cube?.blankChannels ?? [];
  /** Next channel in `dir` that has data (blank channels are skipped when stepping); null when there is none. */
  const stepTarget = (dir: 1 | -1): number | null => {
    if (!cube) return null;
    for (let c = ch + dir; c >= 0 && c < cube.depth; c += dir) if (!blank.includes(c)) return c;
    return null;
  };
  const step = (dir: 1 | -1) => { const c = stepTarget(dir); if (c !== null) actions.setChannel(c); };

  useEffect(() => {
    if (!cube) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      if (e.key === '[') step(-1);
      if (e.key === ']') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cube, ch, actions]);

  const spectrum = useMemo(() => {
    if (!cube) return null;
    return Array.from({ length: cube.depth }, (_, k) => centreMean(cube, k));
  }, [cube, state.cubeTick]);

  if (!cube) {
    return (
      <section className="channels channels--empty" aria-label="Spectral channels">
        <span className="eyebrow">Spectral <Term k="channel">channels</Term></span>
        <p className="channels__note">
          {state.dataset
            ? 'The loaded product is a set of individual exposures. Each exposure samples one wavelength range per detector pixel and has no 102-channel slices, so no channel image can be shown. Level-2 exposures are not spectral cubes. For live data, the real DR1 All-Sky Cube tile can be loaded from the viewer; or open a cube with “Open FITS file”, or use the demo cube.'
            : 'Load a position or a FITS cube to explore channels.'}
        </p>
      </section>
    );
  }

  const wl = cube.wavelengthsUm?.[ch] ?? null;
  const vals = spectrum ? spectrum.filter((v): v is number => v !== null) : [];
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const lazy = cube.lazy;
  const remaining = lazy ? cube.depth - blank.length - lazy.loadedCount() + blank.filter((b) => lazy.isLoaded(b)).length : 0;
  const pts = spectrum
    ? spectrum.map((v, k) => (v === null ? null : `${(k / (cube.depth - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 26}`))
    : [];

  return (
    <section className="channels" aria-label="Spectral channels">
      <div className="channels__head">
        <span className="eyebrow">Spectral <Term k="channel">channels</Term></span>
        <span className="mono channels__value">channel <strong>{ch + 1}</strong> / {cube.depth}</span>
        <span className="mono channels__wl">{wl !== null ? `λ ≈ ${wl.toFixed(3)} µm${cube.wavelengthEdgesUm?.[ch] ? ` (${cube.wavelengthEdgesUm[ch]![0].toFixed(3)}–${cube.wavelengthEdgesUm[ch]![1].toFixed(3)})` : ''}` : 'wavelength: not in file header'}</span>
      </div>
      <div className="channels__row">
        <button className="btn btn--icon" onClick={() => step(-1)} disabled={stepTarget(-1) === null} aria-label="Previous channel">◀</button>
        <div className="channels__slider">
          <input type="range" min={1} max={cube.depth} step={1} value={ch + 1} onChange={(e) => actions.setChannel(Number(e.target.value) - 1)} aria-label="Spectral channel number" />
          {spectrum && (
            <svg className="channels__strip" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
              <polyline points={pts.filter(Boolean).join(' ')} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1={(ch / (cube.depth - 1)) * 100} x2={(ch / (cube.depth - 1)) * 100} y1="0" y2="30" stroke="var(--accent-warm)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
        </div>
        <button className="btn btn--icon" onClick={() => step(1)} disabled={stepTarget(1) === null} aria-label="Next channel">▶</button>
        <input className="channels__num mono" type="number" min={1} max={cube.depth} value={ch + 1} onChange={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= cube.depth) actions.setChannel(n - 1); }} aria-label="Go to channel" />
      </div>
      <p className="channels__note">
        Trace: mean of the central 5×5 pixels per slice — uncalibrated quick-look. Keys <kbd>[</kbd> <kbd>]</kbd> step channels.
        {cube.wavelengthsUm === null && (info
          ? ' No validated wavelength table was found (see provenance), so no wavelengths are shown (none are assumed).'
          : ' This cube’s header has no linear wavelength axis, so no wavelengths are shown (none are assumed).')}
        {info && ' For an All-Sky tile this is the centre of the ~1.8° tile, not your target position (the HPX projection is not converted yet).'}
        {blank.length > 0 && ` Blank channel(s) ${blank.map((b) => b + 1).join(', ')} hold no data: they are skipped when stepping and left out of the trace.`}
        {state.dataset?.origin === 'demo' && ' DEMO: the channel images are synthetic.'}
      </p>
      {lazy && (
        <div className="channels__bulk">
          <span className="mono">{lazy.loadedCount()} / {cube.depth - blank.length} channels loaded</span>
          {state.bulk
            ? <progress max={state.bulk.total} value={state.bulk.done} aria-label="Loading all channels" />
            : remaining > 0 && <button className="btn" onClick={() => void actions.loadAllChannels()}>Load all channels (~{((remaining * lazy.bytesPerChannel) / 1e6).toFixed(0)} MB)</button>}
          <span className="dim">The trace above fills in as channels load.</span>
        </div>
      )}
      {state.channelError && <p className="allsky__err" role="alert">{state.channelError.message}</p>}
      {info && (
        <details className="channels__prov">
          <summary>Cube provenance: {info.product}</summary>
          <ul className="channels__note">
            <li>Real NASA/IPAC IRSA data (SPHEREx DR1), not synthetic.</li>
            {info.url && <li>File: <a href={info.url} target="_blank" rel="noreferrer">{info.url.split('/').pop()}</a>{info.bytesRead !== null && ` · read ${(info.bytesRead / 1e6).toFixed(1)} MB`}</li>}
            {info.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
