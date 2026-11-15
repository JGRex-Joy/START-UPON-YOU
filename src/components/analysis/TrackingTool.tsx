import { useMemo, useState } from 'react';
import { useStore } from '../../app/store';
import { analysis } from '../../workers/analysisClient';
import { DEFAULT_TRACKING, matchEpochs, type TrackingOptions } from '../../engines/objectTracking';
import { DEFAULT_DETECTION } from '../../engines/sourceDetection';
import { pixelScaleArcsec } from '../../services/fits/wcs';
import type { TrackMatch } from '../../types';
import { ImageViewer } from '../sky/ImageViewer';
import { epochImage } from '../sky/EpochViewer';
import { EpochSelect } from '../comparison/CompareView';
import { mapView, type Marker, type ViewState } from '../sky/viewState';
import { NyanLoader } from '../mascot/NyanCat';

const KIND_LABEL: Record<TrackMatch['kind'], string> = {
  stable: 'stable', 'potential-mover': 'potential mover', 'potential-variable': 'potential variable', unmatched: 'unmatched',
};

export function TrackingTool() {
  const { state, actions } = useStore();
  const epochs = state.dataset?.epochs ?? [];
  const [aIdx, setA] = useState(state.epochIndex);
  const [bIdx, setB] = useState(() => {
    const b = Math.min(state.compareIndex, Math.max(0, epochs.length - 1));
    // Default to a *different* epoch than the primary one so the first result is meaningful.
    return b === state.epochIndex && epochs.length > 1 ? (state.epochIndex + 1) % epochs.length : b;
  });
  const [opts, setOpts] = useState<TrackingOptions>(DEFAULT_TRACKING);
  const [matches, setMatches] = useState<TrackMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<ViewState | null>(null);
  const [sel, setSel] = useState<number | null>(null);

  const a = epochs[aIdx];
  const b = epochs[bIdx];
  const ia = epochImage(a);
  const ib = epochImage(b);

  const run = async () => {
    setError(null);
    const [ea, eb] = await Promise.all([actions.ensureEpoch(aIdx), actions.ensureEpoch(bIdx)]);
    if (!ea?.image || !eb?.image) { setError('Both epochs must be loaded.'); return; }
    setBusy(true);
    try {
      const o = { ...DEFAULT_DETECTION, ...state.detectOpts };
      const [da, db] = await Promise.all([analysis.detect(ea.image, o), analysis.detect(eb.image, o)]);
      const scale = ea.image.wcs ? pixelScaleArcsec(ea.image.wcs) : null;
      setMatches(matchEpochs(da.candidates, db.candidates, { ...opts, pixelScaleArcsec: scale }));
      setSel(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const markersA: Marker[] = useMemo(() => (matches ?? []).map((m) => ({
    id: `m${m.from.id}`, x: m.from.x, y: m.from.y, kind: m.kind === 'potential-mover' ? 'mover' : 'candidate', label: `#${m.from.id}`, selected: sel === m.from.id,
  })), [matches, sel]);
  const markersB: Marker[] = useMemo(() => (matches ?? []).filter((m) => m.to).map((m) => ({
    id: `m${m.from.id}`, x: m.to!.x, y: m.to!.y, kind: m.kind === 'potential-mover' ? 'mover' : 'candidate', label: `#${m.from.id}`, selected: sel === m.from.id,
  })), [matches, sel]);

  const movers = (matches ?? []).filter((m) => m.kind === 'potential-mover');
  const vars = (matches ?? []).filter((m) => m.kind === 'potential-variable');

  if (epochs.length < 2) {
    return <div className="stage__empty"><p className="stage__empty-title">Tracking needs two epochs</p><p className="dim">Only {epochs.length} observation epoch{epochs.length === 1 ? ' is' : 's are'} available.</p></div>;
  }
  const differentBands = !!(a?.detector && b?.detector && a.detector !== b.detector);
  const pick = (m: Marker) => setSel(Number(m.id.slice(1)));

  return (
    <div className="tool">
      <aside className="tool__side">
        <h2 className="tool__h">Cross-epoch matching</h2>
        <EpochSelect label="Epoch A" value={aIdx} onChange={(i) => { setA(i); setMatches(null); }} epochs={epochs} />
        <EpochSelect label="Epoch B" value={bIdx} onChange={(i) => { setB(i); setMatches(null); }} epochs={epochs} />
        {differentBands && <p className="notice notice--warn">Different detectors: flux ratios compare different wavelengths and are not meaningful as variability.</p>}
        <div className="field">
          <label htmlFor="mr">Match radius <span className="mono">{opts.matchRadiusArcsec}″</span></label>
          <input id="mr" type="range" min={6} max={180} step={2} value={opts.matchRadiusArcsec} onChange={(e) => setOpts({ ...opts, matchRadiusArcsec: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="mt">Mover threshold <span className="mono">{opts.moverThresholdArcsec}″</span></label>
          <input id="mt" type="range" min={2} max={60} step={1} value={opts.moverThresholdArcsec} onChange={(e) => setOpts({ ...opts, moverThresholdArcsec: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="vr">Variable flux ratio <span className="mono">×{opts.variableRatio.toFixed(1)}</span></label>
          <input id="vr" type="range" min={1.1} max={4} step={0.1} value={opts.variableRatio} onChange={(e) => setOpts({ ...opts, variableRatio: Number(e.target.value) })} />
        </div>
        <button className="btn btn--primary" onClick={() => void run()} disabled={busy}>{busy ? 'Matching…' : 'Detect & match'}</button>
        {error && <p className="notice notice--warn" role="alert">{error}</p>}
        {matches && (
          <>
            <dl className="kv kv--tight">
              <dt>Sources in A</dt><dd className="mono">{matches.length}</dd>
              <dt>Potential movers</dt><dd className="mono"><strong>{movers.length}</strong></dd>
              <dt>Potential variables</dt><dd className="mono"><strong>{vars.length}</strong></dd>
              <dt>Unmatched</dt><dd className="mono">{matches.filter((m) => m.kind === 'unmatched').length}</dd>
            </dl>
            <div className="table-wrap">
              <table className="table mono">
                <caption className="sr-only">Cross-epoch matches</caption>
                <thead><tr><th>#</th><th>Class</th><th>Δ″</th><th>F₂/F₁</th></tr></thead>
                <tbody>
                  {matches.filter((m) => m.kind !== 'stable').slice(0, 50).map((m) => (
                    <tr key={m.from.id} className={sel === m.from.id ? 'is-selected' : ''} onClick={() => setSel(m.from.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setSel(m.from.id); }}>
                      <td>{m.from.id}</td><td>{KIND_LABEL[m.kind]}</td>
                      <td>{m.displacementArcsec !== null ? m.displacementArcsec.toFixed(1) : m.displacementPx !== null ? `${m.displacementPx.toFixed(1)}px` : '—'}</td>
                      <td>{m.fluxRatio !== null ? m.fluxRatio.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="notice">
          Flags are <strong>potential</strong> only. A shift or flux change can come from noise, mis-registration, WCS distortion (SIP is ignored) or different wavelength sampling. Confirmation needs more epochs and calibrated data.
        </p>
      </aside>
      <div className="tool__stage">
        <div className="compare__panes compare__panes--side tool__viewer">
          {busy && <div className="viewer__busy"><NyanLoader label="Detecting and matching…" /></div>}
          <div className="compare__pane"><ImageViewer ariaLabel="Epoch A" image={ia} render={state.render} showGrid={state.showGrid} view={shared} onViewChange={setShared} markers={markersA} onMarkerClick={pick} badge={<span className="mono">A · {a?.isoDate?.slice(0, 10) ?? a?.label}</span>} /></div>
          <div className="compare__pane"><ImageViewer ariaLabel="Epoch B" image={ib} render={state.render} showGrid={state.showGrid}
            view={shared && ia && ib ? mapView(shared, ia, ib) : shared} onViewChange={(v) => setShared(ia && ib ? mapView(v, ib, ia) : v)} markers={markersB} onMarkerClick={pick} badge={<span className="mono">B · {b?.isoDate?.slice(0, 10) ?? b?.label}</span>} /></div>
        </div>
      </div>
    </div>
  );
}
