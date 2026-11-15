import { useStore } from '../../app/store';

const fmt = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : 'date not reported');

/**
 * Every observation (exposure) the archive reported for the selected position, one row each, with its recorded
 * timestamp and metadata. Selecting a row loads that exposure's real image. These are epochs in TIME; the 102
 * spectral channels are a different thing and never appear here.
 */
export function ObservationList() {
  const { state, actions } = useStore();
  const eps = state.dataset?.epochs ?? [];
  if (eps.length === 0) return null;
  return (
    <ul className="obslist" aria-label="Available observations">
      {eps.map((e, i) => (
        <li key={e.id}>
          <button className={`obslist__row ${i === state.epochIndex ? 'is-active' : ''}`} aria-current={i === state.epochIndex} data-testid="obs-row" onClick={() => actions.selectEpoch(i)}>
            <span className="mono obslist__date">{fmt(e.isoDate)}</span>
            <span className="dim obslist__meta">
              {e.detector ?? 'detector n/a'}
              {e.wavelengthRangeUm ? ` · ${e.wavelengthRangeUm[0].toFixed(2)}–${e.wavelengthRangeUm[1].toFixed(2)} µm` : ''}
              {e.status === 'loading' ? ' · loading…' : e.status === 'error' ? ' · failed' : e.status === 'ready' ? ' · loaded' : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
