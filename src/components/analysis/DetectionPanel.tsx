import { useStore } from '../../app/store';
import { Term } from '../layout/Term';
import { formatDecDms, formatRaHms } from '../../utils/coords';
import { pixelScaleArcsec } from '../../services/fits/wcs';

/** Controls + results for the browser-based candidate source detection. */
export function DetectionPanel({ epochIndex }: { epochIndex: number }) {
  const { state, actions } = useStore();
  const ep = state.dataset?.epochs[epochIndex];
  const res = ep ? state.detection[ep.id] : undefined;
  const o = state.detectOpts;
  const sel = res?.candidates.find((c) => c.id === state.selectedCandidate) ?? null;
  const setOpt = (p: Partial<typeof o>) => actions.patch({ detectOpts: { ...o, ...p } });
  const scale = ep?.image?.wcs ? pixelScaleArcsec(ep.image.wcs) : null;
  const unit = ep?.image?.bunit ?? 'image units';

  return (
    <div className="panelstack">
      <div className="field">
        <label htmlFor="det-k"><Term k="threshold">Threshold</Term> k <span className="mono">= {o.k.toFixed(1)}</span> <Term k="sigma">σ</Term></label>
        <input id="det-k" type="range" min={2} max={15} step={0.5} value={o.k} onChange={(e) => setOpt({ k: Number(e.target.value) })} />
        <span className="field__hint">T = μ<sub>bkg</sub> + k·σ. Lower k finds fainter candidates and more noise.</span>
      </div>
      <div className="field">
        <label htmlFor="det-px">Minimum connected pixels <span className="mono">= {o.minPixels}</span></label>
        <input id="det-px" type="range" min={1} max={20} step={1} value={o.minPixels} onChange={(e) => setOpt({ minPixels: Number(e.target.value) })} />
      </div>
      <label className="check"><input type="checkbox" checked={o.smooth} onChange={(e) => setOpt({ smooth: e.target.checked })} /> 3×3 smoothing before thresholding</label>
      <label className="check"><input type="checkbox" checked={o.rejectEdges} onChange={(e) => setOpt({ rejectEdges: e.target.checked })} /> Reject candidates touching the edge</label>
      <button className="btn btn--primary" onClick={() => void actions.runDetection(epochIndex)} disabled={!ep || state.detectBusy}>
        {state.detectBusy ? 'Detecting…' : res ? 'Re-run detection' : 'Detect sources'}
      </button>
      {state.detectError && <p className="notice notice--warn" role="alert">{state.detectError}</p>}

      {res && (
        <>
          <dl className="kv kv--tight">
            <dt>Candidates</dt><dd className="mono"><strong>{res.candidates.length}</strong></dd>
            <dt>Background μ</dt><dd className="mono">{res.background.toPrecision(5)} {unit}</dd>
            <dt><Term k="sigma">Noise σ</Term> (MAD)</dt><dd className="mono">{res.sigma.toPrecision(4)}</dd>
            <dt>Threshold T</dt><dd className="mono">{res.threshold.toPrecision(5)}</dd>
            <dt>Valid pixels</dt><dd className="mono">{res.validPixels.toLocaleString()}</dd>
          </dl>
          {sel && (
            <div className="candidate-card" role="region" aria-label={`Candidate ${sel.id}`}>
              <div className="candidate-card__head"><strong>Candidate #{sel.id}</strong><span className="badge badge--cand">unverified</span></div>
              <dl className="kv kv--tight">
                <dt>Pixel</dt><dd className="mono">{sel.x.toFixed(2)}, {sel.y.toFixed(2)}</dd>
                {sel.sky && <><dt>RA</dt><dd className="mono">{formatRaHms(sel.sky.ra, 2)} <span className="dim">({sel.sky.ra.toFixed(5)}°)</span></dd>
                  <dt>Dec</dt><dd className="mono">{formatDecDms(sel.sky.dec, 1)} <span className="dim">({sel.sky.dec.toFixed(5)}°)</span></dd></>}
                <dt>Peak above bkg</dt><dd className="mono">{sel.peak.toPrecision(4)}</dd>
                <dt>Summed flux</dt><dd className="mono">{sel.flux.toPrecision(4)} <span className="dim">(uncalibrated, not aperture photometry)</span></dd>
                <dt>Area</dt><dd className="mono">{sel.area} px{scale ? ` (${(sel.area * scale * scale).toFixed(0)} arcsec²)` : ''}</dd>
                <dt><Term k="snr">SNR</Term></dt><dd className="mono">{sel.snr.toFixed(1)}</dd>
                <dt>Rank score</dt><dd className="mono">{sel.score.toFixed(2)} <span className="dim">heuristic, not a probability</span></dd>
              </dl>
            </div>
          )}
          <div className="table-wrap">
            <table className="table mono">
              <caption className="sr-only">Detected candidate sources</caption>
              <thead><tr><th>#</th><th>RA°</th><th>Dec°</th><th>Peak</th><th>SNR</th></tr></thead>
              <tbody>
                {res.candidates.slice(0, 60).map((c) => (
                  <tr key={c.id} className={c.id === state.selectedCandidate ? 'is-selected' : ''} onClick={() => actions.patch({ selectedCandidate: c.id })} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') actions.patch({ selectedCandidate: c.id }); }}>
                    <td>{c.id}</td>
                    <td>{c.sky ? c.sky.ra.toFixed(4) : `x${c.x.toFixed(0)}`}</td>
                    <td>{c.sky ? c.sky.dec.toFixed(4) : `y${c.y.toFixed(0)}`}</td>
                    <td>{c.peak.toPrecision(3)}</td>
                    <td>{c.snr.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {res.candidates.length > 60 && <p className="dim">Showing the 60 brightest of {res.candidates.length}.</p>}
          </div>
        </>
      )}
      <p className="notice">
        Single-image detection finds <Term k="candidate">candidate</Term> sources only. It is not moving-object detection — motion needs several epochs (see Tracking) — and nothing here is a confirmed astronomical discovery.
      </p>
    </div>
  );
}
