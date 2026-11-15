import { useState, type ReactNode } from 'react';
import { useStore } from '../../app/store';
import { pixelScaleArcsec } from '../../services/fits/wcs';
import { Term } from '../layout/Term';

function Row({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className="mono">{v}</dd>
    </>
  );
}

/** Data provenance: mission, instrument, product, date and the metadata actually available. */
export function ProvenancePanel({ epochIndex }: { epochIndex?: number }) {
  const { state } = useStore();
  const [showHeader, setShowHeader] = useState(false);
  const ds = state.dataset;
  const ep = ds?.epochs[epochIndex ?? state.epochIndex];
  if (!ds) return <p className="dim">No data loaded.</p>;

  const prov = ep?.provenance;
  const img = ep?.image;
  return (
    <div className="prov">
      <p className="prov__structure">{ds.structureNote}</p>
      {ep && prov ? (
        <dl className="kv">
          <Row k="Mission" v={prov.mission} />
          <Row k="Instrument" v={prov.instrument} />
          <Row k="Product" v={prov.product} />
          <Row k="Observed" v={ep.isoDate ? `${ep.isoDate.slice(0, 19).replace('T', ' ')} UTC` : 'not available'} />
          {ep.mjd !== null && <Row k="MJD" v={ep.mjd.toFixed(5)} />}
          <Row k={<Term k="detector">Detector</Term>} v={ep.detector ?? '—'} />
          <Row k="λ range" v={ep.wavelengthRangeUm ? `${ep.wavelengthRangeUm[0].toFixed(3)}–${ep.wavelengthRangeUm[1].toFixed(3)} µm` : 'not reported'} />
          {img && <Row k="Size" v={`${img.width} × ${img.height} px`} />}
          {img?.wcs && <Row k="Pixel scale" v={`${pixelScaleArcsec(img.wcs).toFixed(2)}″/px`} />}
          {img && <Row k={<Term k="bunit">Unit</Term>} v={img.bunit ?? 'not stated'} />}
          {img && <Row k={<Term k="wcs">WCS</Term>} v={img.wcs ? `${img.wcs.ctype[0]}${img.wcs.hasSip ? ' (SIP ignored)' : ''}` : 'none'} />}
        </dl>
      ) : (
        <p className="dim">No individual epoch selected.</p>
      )}
      {prov?.notes && prov.notes.length > 0 && (
        <ul className="prov__notes">{prov.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      )}
      {prov?.url && <p className="prov__url mono" title={prov.url}><a href={prov.url} target="_blank" rel="noreferrer">cutout FITS ↗</a></p>}
      {img && (
        <>
          <button className="linkbtn" onClick={() => setShowHeader((v) => !v)} aria-expanded={showHeader}>{showHeader ? 'Hide' : 'Show'} FITS header ({Object.keys(img.header).length} keywords)</button>
          {showHeader && (
            <div className="prov__header mono" tabIndex={0}>
              {Object.entries(img.header).map(([k, c]) => <div key={k}><span className="dim">{k}</span> {String(c.value)}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
