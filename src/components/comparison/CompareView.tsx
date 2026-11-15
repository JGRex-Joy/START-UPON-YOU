import { useEffect, useState } from 'react';
import { useStore } from '../../app/store';
import { ImageViewer } from '../sky/ImageViewer';
import { EpochBadge, epochImage } from '../sky/EpochViewer';
import { mapView, type ViewState } from '../sky/viewState';
import type { EpochEntry } from '../../types';
import { NyanLoader } from '../mascot/NyanCat';

export const epochOptionLabel = (e: EpochEntry, i: number) =>
  `${i + 1}. ${e.isoDate ? e.isoDate.slice(0, 10) : e.label}${e.detector ? ` · ${e.detector}` : ''}`;

export function EpochSelect({ value, onChange, label, epochs }: { value: number; onChange: (i: number) => void; label: string; epochs: EpochEntry[] }) {
  return (
    <label className="select-labeled">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {epochs.map((e, i) => <option key={e.id} value={i}>{epochOptionLabel(e, i)}</option>)}
      </select>
    </label>
  );
}

function Caption({ epoch }: { epoch: EpochEntry | undefined }) {
  if (!epoch) return null;
  const p = epoch.provenance;
  return (
    <div className="compare__caption mono">
      <span>{epoch.isoDate ? `${epoch.isoDate.slice(0, 19).replace('T', ' ')} UTC` : p.origin === 'demo' ? `${epoch.label} (synthetic, undated)` : 'date unavailable'}</span>
      <span className="dim">{p.instrument}{epoch.wavelengthRangeUm ? ` · ${epoch.wavelengthRangeUm[0].toFixed(2)}–${epoch.wavelengthRangeUm[1].toFixed(2)} µm` : ''}</span>
      {epoch.image && <span className="dim">{epoch.image.width}×{epoch.image.height} px{epoch.image.bunit ? ` · ${epoch.image.bunit}` : ''}</span>}
    </div>
  );
}

/** Side-by-side (or stacked) comparison of two epochs with synchronised pan and zoom. */
export function CompareView() {
  const { state, actions } = useStore();
  const epochs = state.dataset?.epochs ?? [];
  const [layout, setLayout] = useState<'side' | 'stack'>('side');
  const [shared, setShared] = useState<ViewState | null>(null);
  const a = epochs[state.epochIndex];
  const bIdx = Math.min(state.compareIndex, Math.max(0, epochs.length - 1));
  const b = epochs[bIdx];

  useEffect(() => { void actions.ensureEpoch(state.epochIndex); void actions.ensureEpoch(bIdx); }, [state.epochIndex, bIdx, actions]);

  if (epochs.length < 2) {
    return (
      <div className="stage__empty">
        <p className="stage__empty-title">Comparison needs two epochs</p>
        <p className="dim">This position has {epochs.length} observation epoch{epochs.length === 1 ? '' : 's'} in the loaded data product. Try another position or the demo data.</p>
      </div>
    );
  }
  const ia = epochImage(a);
  const ib = epochImage(b);
  const pending = (e: EpochEntry | undefined) => (e && (e.status === 'loading' || e.status === 'idle') ? <NyanLoader label="Loading epoch…" /> : e?.status === 'error' ? <span className="error-text">{e.error}</span> : null);

  return (
    <div className="compare">
      <div className="compare__bar">
        <EpochSelect label="Left / top" value={state.epochIndex} onChange={actions.selectEpoch} epochs={epochs} />
        <EpochSelect label="Right / bottom" value={bIdx} onChange={actions.selectCompare} epochs={epochs} />
        <div className="seg" role="radiogroup" aria-label="Layout">
          <button role="radio" aria-checked={layout === 'side'} className={layout === 'side' ? 'is-active' : ''} onClick={() => setLayout('side')}>Side by side</button>
          <button role="radio" aria-checked={layout === 'stack'} className={layout === 'stack' ? 'is-active' : ''} onClick={() => setLayout('stack')}>Stacked</button>
        </div>
        <span className="dim compare__sync mono">pan &amp; zoom synchronised{ia?.wcs && ib?.wcs ? ' via WCS' : ''}</span>
      </div>
      {a && b && a.detector && b.detector && a.detector !== b.detector && (
        <p className="notice notice--warn" role="status">
          These exposures are from different detectors ({a.detector} vs {b.detector}), so they sample different wavelengths. Visual differences are not necessarily changes in the sky.
        </p>
      )}
      <div className={`compare__panes compare__panes--${layout}`}>
        <div className="compare__pane">
          <ImageViewer ariaLabel="Left comparison viewer" image={ia} render={state.render} showGrid={state.showGrid}
            view={shared} onViewChange={setShared} badge={<EpochBadge epoch={a} />} empty={pending(a)} />
          <Caption epoch={a} />
        </div>
        <div className="compare__pane">
          <ImageViewer ariaLabel="Right comparison viewer" image={ib} render={state.render} showGrid={state.showGrid}
            view={shared && ia && ib ? mapView(shared, ia, ib) : shared}
            onViewChange={(v) => setShared(ia && ib ? mapView(v, ib, ia) : v)}
            badge={<EpochBadge epoch={b} />} empty={pending(b)} />
          <Caption epoch={b} />
        </div>
      </div>
    </div>
  );
}
