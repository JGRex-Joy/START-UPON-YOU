import { useEffect, useMemo, useState } from 'react';
import { useStore, SPHEREX_REF_EPOCH } from '../../app/store';
import type { SkySelection } from '../../app/skyUrl';
import { FOCUS_LABEL } from '../../services/targets';
import { ALLSKY_DEPTH, allSkyTile } from '../../services/spherex/allSkyCube';
import { checkTileAvailability, type TileAvailability } from '../../services/aws/tileAvailability';
import { formatDecDms, formatRaHms, propagate } from '../../utils/coords';

type Check = { status: 'checking' } | TileAvailability;

/** One anonymous existence check per selected tile (debounced, cancelled when the selection changes). */
function useTileCheck(npix: number): { check: Check; retry: () => void } {
  const [check, setCheck] = useState<Check>({ status: 'checking' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setCheck({ status: 'checking' });
    const t = setTimeout(() => {
      checkTileAvailability(npix, ctl.signal).then((r) => { if (!ctl.signal.aborted) setCheck(r); }, () => { /* aborted */ });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [npix, nonce]);
  return { check, retry: () => setNonce((n) => n + 1) };
}

const mb = (n: number | null) => (n === null ? 'size unknown' : `${(n / 1e6).toFixed(0)} MB`);

export function ObjectInspector({ selection, onExplore, onClose }: { selection: SkySelection; onExplore: () => void; onClose: () => void }) {
  const { state } = useStore();
  const { pos, challenge } = selection;
  const npix = useMemo(() => allSkyTile(pos).npix, [pos.ra, pos.dec]);
  const { check, retry } = useTileCheck(npix);
  const epochPos = challenge && challenge.pmRa !== null && challenge.pmDec !== null ? propagate(pos, challenge.pmRa, challenge.pmDec, SPHEREX_REF_EPOCH - 2000) : null;

  // Epoch information exists only after the Observatory has queried IRSA for THIS target; never shown from anywhere else.
  const sameTarget = state.target && state.target.pos.ra === pos.ra && state.target.pos.dec === pos.dec;
  const epochs = sameTarget && state.dataset?.origin === 'spherex-live' ? state.dataset.epochs : null;
  const dated = epochs?.filter((e) => e.mjd !== null) ?? [];

  return (
    <aside className="inspector" aria-label="Object inspector" data-testid="inspector">
      <header className="inspector__head">
        <div>
          <p className={`inspector__eyebrow ${challenge ? `is-${challenge.focus}` : ''}`}>
            {challenge ? `Featured target · ${FOCUS_LABEL[challenge.focus]}` : 'Sky position'}
          </p>
          <h2 className="inspector__title" data-testid="inspector-title">{challenge ? challenge.name : 'Selected position'}</h2>
          <p className="inspector__kind">{challenge ? challenge.kind : 'No catalog source was looked up here, so no object is identified.'}</p>
        </div>
        <button className="inspector__close" onClick={onClose} aria-label="Close inspector">×</button>
      </header>

      <div className="inspector__scroll">
        <section className="inspector__sec">
          <h3>Position (ICRS)</h3>
          <dl className="kv">
            <dt>RA</dt><dd className="mono" data-testid="inspector-ra">{formatRaHms(pos.ra)} · {pos.ra.toFixed(5)}°</dd>
            <dt>Dec</dt><dd className="mono" data-testid="inspector-dec">{formatDecDms(pos.dec)} · {pos.dec.toFixed(5)}°</dd>
            {epochPos && <><dt>At {SPHEREX_REF_EPOCH.toFixed(1)}</dt><dd className="mono">{epochPos.ra.toFixed(5)}°, {epochPos.dec.toFixed(5)}°</dd></>}
          </dl>
          {challenge
            ? <p className="inspector__fine">Catalogued J2000 position, precision {challenge.precision}. {epochPos ? 'This target moves quickly: the Observatory searches at the proper-motion-propagated position shown above, not at the map marker.' : ''} Source: <a href={challenge.source.url} target="_blank" rel="noreferrer">{challenge.source.label}</a></p>
            : <p className="inspector__fine">Taken from your click or entered coordinates; precision is limited by that input.</p>}
        </section>

        <section className="inspector__sec" aria-live="polite">
          <h3>SPHEREx All-Sky Cube (DR1, AWS)</h3>
          <dl className="kv">
            <dt>Tile</dt><dd className="mono" data-testid="inspector-tile">Npix{npix} · HEALPix order 5</dd>
            <dt>Archive</dt>
            <dd data-testid="inspector-aws">
              {check.status === 'checking' && <span className="dim">Checking AWS…</span>}
              {check.status === 'found' && <span className="ok">Tile found · {mb(check.size)}</span>}
              {check.status === 'absent' && <span className="warn">No tile published</span>}
              {check.status === 'error' && <span className="warn">Could not check</span>}
            </dd>
            {check.status === 'found' && <><dt>Spectral data</dt><dd>{ALLSKY_DEPTH} channels per tile</dd></>}
            {check.status === 'found' && check.lastModified && <><dt>Object date</dt><dd className="mono">{new Date(check.lastModified).toISOString().slice(0, 10)}</dd></>}
          </dl>
          {check.status === 'absent' && <p className="inspector__fine">{check.message}</p>}
          {check.status === 'error' && (
            <p className="inspector__fine">{check.message}{check.retryable && <> <button className="linkbtn" onClick={retry}>Try again</button></>}</p>
          )}
          {check.status === 'found' && <p className="inspector__fine">The tile exists in the public bucket (anonymous HEAD request). Pixels are read only when you open it in the Observatory.</p>}
        </section>

        <section className="inspector__sec">
          <h3>Observations over time</h3>
          {epochs
            ? (
              <p className="inspector__fine" data-testid="inspector-epochs">
                {epochs.length === 0
                  ? 'IRSA reported no individual SPHEREx exposures covering this position.'
                  : `${epochs.length} individual exposure${epochs.length === 1 ? '' : 's'} retrieved from IRSA${dated.length ? `, ${dated[0].isoDate?.slice(0, 10)} → ${dated[dated.length - 1].isoDate?.slice(0, 10)}` : ' (undated)'}.`}
              </p>
            )
            : <p className="inspector__fine" data-testid="inspector-epochs">Not retrieved yet. Exposure dates and product identifiers come from the IRSA discovery service, which runs when you open this position in the Observatory (it is optional: the All-Sky Cube above does not need it).</p>}
        </section>

        {challenge && (
          <section className="inspector__sec">
            <h3>Why this target</h3>
            <p className="inspector__fine">{challenge.note} Nothing has been analysed yet: results appear only after you investigate.</p>
          </section>
        )}
      </div>

      <footer className="inspector__actions">
        <button className="btn btn--primary" onClick={onExplore} data-testid="inspector-explore">{challenge ? 'Start Investigation' : 'Explore This Position'}</button>
        <p className="inspector__fine">Opens the Observatory workspace on this target; Spectral, Time and Analysis tools keep it selected.</p>
      </footer>
    </aside>
  );
}
