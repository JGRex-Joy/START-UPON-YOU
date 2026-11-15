import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../app/store';
import { analysis } from '../../workers/analysisClient';
import { DEFAULT_SUBTRACTION, type SubtractionOptions } from '../../engines/imageSubtraction';
import { resampleBilinear, type RenderOptions } from '../../engines/imageProcessing';
import type { DifferenceResult } from '../../types';
import { ImageViewer, type ViewerImage } from '../sky/ImageViewer';
import { epochImage } from '../sky/EpochViewer';
import { EpochSelect } from '../comparison/CompareView';
import type { ViewState } from '../sky/viewState';
import { Term } from '../layout/Term';
import { NyanLoader } from '../mascot/NyanCat';

type Mode = 'diff' | 'before' | 'after' | 'wipe';

export function SubtractionTool() {
  const { state, actions } = useStore();
  const epochs = state.dataset?.epochs ?? [];
  const [aIdx, setA] = useState(state.epochIndex);
  const [bIdx, setB] = useState(() => {
    const b = Math.min(state.compareIndex, Math.max(0, epochs.length - 1));
    // Default to a *different* epoch than the primary one so the first result is meaningful.
    return b === state.epochIndex && epochs.length > 1 ? (state.epochIndex + 1) % epochs.length : b;
  });
  const [opts, setOpts] = useState<SubtractionOptions>(DEFAULT_SUBTRACTION);
  const [result, setResult] = useState<DifferenceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('diff');
  const [contrast, setContrast] = useState(6);
  const [wipe, setWipe] = useState(50);
  const [view, setView] = useState<ViewState | null>(null);

  const a = epochs[aIdx];
  const b = epochs[bIdx];
  useEffect(() => { setResult(null); setError(null); }, [aIdx, bIdx, state.dataset]);

  const run = async () => {
    setError(null);
    const [ea, eb] = await Promise.all([actions.ensureEpoch(aIdx), actions.ensureEpoch(bIdx)]);
    if (!ea?.image || !eb?.image) { setError('Both epochs must be loaded to subtract. One of them failed to load or has no image.'); return; }
    setBusy(true);
    try {
      setResult(await analysis.subtract(ea.image, eb.image, opts));
      setView(null);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const base = epochImage(a);
  const afterImg: ViewerImage | null = useMemo(() => {
    const i2 = b?.image;
    if (!base || !i2) return null;
    const data = i2.width === base.width && i2.height === base.height ? i2.data : resampleBilinear(i2.data, i2.width, i2.height, base.width, base.height);
    return { data, width: base.width, height: base.height, wcs: base.wcs };
  }, [b?.image, base]);
  const diffImg: ViewerImage | null = useMemo(() => (result && base ? { data: result.data, width: result.width, height: result.height, wcs: base.wcs } : null), [result, base]);

  const divRender: RenderOptions = useMemo(() => ({ ...state.render, colormap: 'diverging', stretch: 'linear', symmetricLimit: result && Number.isFinite(result.sigma) ? contrast * result.sigma : undefined }), [state.render, result, contrast]);
  const planeRender: RenderOptions = state.render;

  const differentBands = !!(a?.detector && b?.detector && a.detector !== b.detector);

  if (epochs.length < 2) {
    return <div className="stage__empty"><p className="stage__empty-title">Subtraction needs two epochs</p><p className="dim">Only {epochs.length} observation epoch{epochs.length === 1 ? ' is' : 's are'} available in the loaded data.</p></div>;
  }

  const shown = (() => {
    if (mode === 'diff') return { img: diffImg, render: divRender };
    if (mode === 'before') return { img: base, render: planeRender };
    if (mode === 'after') return { img: afterImg, render: planeRender };
    return { img: base, render: planeRender };
  })();

  return (
    <div className="tool">
      <aside className="tool__side">
        <h2 className="tool__h">Image subtraction</h2>
        <p className="formula mono">D(x,y) = I₂(x,y) − I₁(x,y)</p>
        <EpochSelect label="Image 1 (before)" value={aIdx} onChange={setA} epochs={epochs} />
        <EpochSelect label="Image 2 (after)" value={bIdx} onChange={setB} epochs={epochs} />
        {aIdx === bIdx && <p className="notice notice--warn">Both selections are the same epoch; the difference will be ~0.</p>}
        {differentBands && <p className="notice notice--warn">Different detectors ({a?.detector} vs {b?.detector}): the exposures sample different wavelengths, so the difference is dominated by spectral differences, not change.</p>}
        <label className="check"><input type="checkbox" checked={opts.matchDimensions} onChange={(e) => setOpts({ ...opts, matchDimensions: e.target.checked })} /> Resample image 2 if sizes differ</label>
        <label className="check"><input type="checkbox" checked={opts.normalizeBackground} onChange={(e) => setOpts({ ...opts, normalizeBackground: e.target.checked })} /> Normalise background (median)</label>
        <label className="check"><input type="checkbox" checked={opts.register} onChange={(e) => setOpts({ ...opts, register: e.target.checked })} /> <Term k="registration">Register</Term> (integer-pixel shift)</label>
        <div className="field">
          <label htmlFor="gate">Noise gate <span className="mono">{opts.noiseGateK === 0 ? 'off' : `|D| < ${opts.noiseGateK.toFixed(1)}σ → 0`}</span></label>
          <input id="gate" type="range" min={0} max={5} step={0.5} value={opts.noiseGateK} onChange={(e) => setOpts({ ...opts, noiseGateK: Number(e.target.value) })} />
        </div>
        <button className="btn btn--primary" onClick={() => void run()} disabled={busy}>{busy ? 'Subtracting…' : result ? 'Recompute' : 'Compute difference'}</button>
        {error && <p className="notice notice--warn" role="alert">{error}</p>}

        {result && (
          <>
            <div className="field">
              <label htmlFor="contrast">Contrast (±<span className="mono">{contrast}</span> σ<sub>D</sub>) <Term k="diverging">diverging scale</Term></label>
              <input id="contrast" type="range" min={1} max={30} step={1} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} />
            </div>
            <dl className="kv kv--tight">
              <dt>σ of difference</dt><dd className="mono">{result.sigma.toPrecision(4)}</dd>
              <dt>Applied shift</dt><dd className="mono">{result.shift[0] === 0 && result.shift[1] === 0 ? 'none' : `${-result.shift[0]}, ${-result.shift[1]} px`}</dd>
            </dl>
            <ul className="prov__notes">{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </>
        )}
        <p className="notice notice--strong">
          <strong>Basic pixel-difference prototype.</strong> No PSF matching, no photometric or flat-field calibration, no flux scaling between exposures. Residuals are not scientifically validated results.
        </p>
      </aside>

      <div className="tool__stage">
        <div className="tool__modes seg" role="radiogroup" aria-label="Display mode">
          {([['diff', 'Difference'], ['before', 'Before (I₁)'], ['after', 'After (I₂)'], ['wipe', 'Before ↔ After']] as [Mode, string][]).map(([m, l]) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'is-active' : ''} onClick={() => setMode(m)} disabled={m === 'diff' && !result}>{l}</button>
          ))}
        </div>
        <div className="tool__viewer">
          {busy && <div className="viewer__busy"><NyanLoader label="Differencing in a worker…" /></div>}
          {mode === 'wipe' ? (
            <div className="wipe">
              <div className="wipe__layer"><ImageViewer ariaLabel="After (image 2)" image={afterImg} render={planeRender} view={view} onViewChange={setView} showGrid={state.showGrid} badge={<span className="mono">AFTER · I₂</span>} /></div>
              <div className="wipe__layer wipe__layer--top" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}>
                <ImageViewer ariaLabel="Before (image 1)" image={base} render={planeRender} view={view} onViewChange={setView} showGrid={state.showGrid} badge={<span className="mono">BEFORE · I₁</span>} />
              </div>
              <div className="wipe__handle" style={{ left: `${wipe}%` }} aria-hidden="true" />
              <input className="wipe__range" type="range" min={0} max={100} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} aria-label="Before/after wipe position" />
            </div>
          ) : (
            <ImageViewer ariaLabel="Subtraction viewer" image={shown.img} render={shown.render} view={view} onViewChange={setView} showGrid={state.showGrid}
              badge={<span className="mono">{mode === 'diff' ? 'D = I₂ − I₁ · uncalibrated' : mode === 'before' ? 'I₁' : 'I₂ (unregistered)'}</span>}
              empty={<span className="dim">Choose two epochs and compute the difference.</span>} />
          )}
        </div>
      </div>
    </div>
  );
}
