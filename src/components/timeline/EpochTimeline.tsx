import { useEffect, useMemo, useRef } from 'react';
import { useStore, visibleIndicesOf } from '../../app/store';
import { formatDuration } from '../../utils/time';
import { Term } from '../layout/Term';

const SPEEDS = [0.5, 1, 2, 4];

/**
 * Horizontal observation timeline. Only real epochs of the loaded data product appear here.
 * Spectral channels are NOT time steps and never appear on this control.
 */
export function EpochTimeline() {
  const { state, actions } = useStore();
  const { dataset, epochIndex, playing, speed, bandFilter } = state;
  const epochs = dataset?.epochs ?? [];
  const visible = useMemo(() => visibleIndicesOf(state), [state]);
  const bands = useMemo(() => Array.from(new Set(epochs.map((e) => e.detector).filter((d): d is string => !!d))).sort(), [epochs]);
  const ref = useRef({ state, actions });
  ref.current = { state, actions };

  // Playback: advance to the next *loaded* epoch; request loading and wait if it is not ready yet.
  useEffect(() => {
    if (!playing || visible.length < 2) return;
    const id = window.setInterval(() => {
      const { state: s, actions: a } = ref.current;
      const vis = visibleIndicesOf(s);
      const pos = vis.indexOf(s.epochIndex);
      const next = vis[(pos + 1) % vis.length];
      const ep = s.dataset?.epochs[next];
      if (!ep) return;
      if (ep.status === 'ready') a.selectEpoch(next);
      else if (ep.status !== 'loading') void a.ensureEpoch(next);
    }, 1400 / speed);
    return () => window.clearInterval(id);
  }, [playing, speed, visible.length]);

  useEffect(() => { if (visible.length < 2 && playing) actions.patch({ playing: false }); }, [visible.length, playing, actions]);

  const dated = visible.length > 0 && visible.every((i) => epochs[i].mjd !== null);
  const geometry = useMemo(() => {
    if (visible.length === 0) return { pos: [] as number[], span: 0, maxGap: 0 };
    if (!dated) return { pos: visible.map((_, k) => (visible.length === 1 ? 50 : (k / (visible.length - 1)) * 100)), span: 0, maxGap: 0 };
    const t = visible.map((i) => epochs[i].mjd as number);
    const lo = t[0];
    const span = t[t.length - 1] - lo;
    let maxGap = 0;
    for (let k = 1; k < t.length; k++) maxGap = Math.max(maxGap, t[k] - t[k - 1]);
    return { pos: t.map((v) => (span === 0 ? 50 : ((v - lo) / span) * 100)), span, maxGap };
  }, [visible, epochs, dated]);

  const step = (d: number) => {
    if (visible.length === 0) return;
    const pos = Math.max(0, visible.indexOf(epochIndex));
    actions.selectEpoch(visible[(pos + d + visible.length) % visible.length]);
  };

  if (!dataset) return <div className="timeline timeline--empty"><span className="dim">Timeline appears once a position is loaded.</span></div>;

  const current = epochs[epochIndex];
  const insufficient = visible.length < 2;

  return (
    <section className="timeline" aria-label="Observation timeline">
      <div className="timeline__head">
        <div className="timeline__title">
          <span className="eyebrow">Observation <Term k="epoch">epochs</Term></span>
          <span className="mono timeline__count">{visible.length} {visible.length === 1 ? 'epoch' : 'epochs'}{bandFilter !== 'all' ? ` · ${bandFilter}` : ''}</span>
        </div>
        <div className="timeline__controls">
          <button className="btn btn--icon" onClick={() => step(-1)} disabled={insufficient} aria-label="Previous epoch">◀</button>
          <button className="btn btn--icon btn--play" onClick={() => actions.patch({ playing: !playing })} disabled={insufficient} aria-label={playing ? 'Pause time-lapse' : 'Play time-lapse'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button className="btn btn--icon" onClick={() => step(1)} disabled={insufficient} aria-label="Next epoch">▶</button>
          <div className="seg" role="radiogroup" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button key={s} role="radio" aria-checked={speed === s} className={speed === s ? 'is-active' : ''} onClick={() => actions.patch({ speed: s })}>{s}×</button>
            ))}
          </div>
          {bands.length > 1 && (
            <label className="select-inline">
              <span className="sr-only">Filter by detector</span>
              <select value={bandFilter} onChange={(e) => {
                const f = e.target.value;
                actions.patch({ bandFilter: f, playing: false });
                const vis = visibleIndicesOf({ ...state, bandFilter: f });
                if (vis.length && !vis.includes(epochIndex)) actions.selectEpoch(vis[0]);
              }}>
                <option value="all">All detectors</option>
                {bands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      {insufficient ? (
        <p className="timeline__notice" role="status">
          {visible.length === 0
            ? 'No observation epochs for this selection.'
            : 'Only one observation epoch is available here — not enough temporal coverage for a time-lapse, comparison or subtraction.'}
        </p>
      ) : (
        <div className="timeline__rail">
          <div className="timeline__line" />
          {visible.map((i, k) => {
            const e = epochs[i];
            const active = i === epochIndex;
            return (
              <button
                key={e.id}
                className={`tick ${active ? 'is-active' : ''} tick--${e.status}`}
                style={{ left: `${geometry.pos[k]}%` }}
                onClick={() => actions.selectEpoch(i)}
                aria-label={`${e.label}${e.detector ? `, ${e.detector}` : ''}${active ? ' (selected)' : ''}`}
                aria-current={active}
                title={`${e.isoDate ? e.isoDate.slice(0, 19).replace('T', ' ') + ' UTC' : e.label}${e.detector ? ` · ${e.detector}` : ''}`}
              />
            );
          })}
        </div>
      )}

      <div className="timeline__foot mono">
        <span className="timeline__selected">
          {current ? (current.isoDate ? `${current.isoDate.slice(0, 19).replace('T', ' ')} UTC` : current.provenance.origin === 'demo' ? `${current.label} · synthetic, undated` : `${current.label} · date unavailable`) : '—'}
        </span>
        {dated && visible.length > 1 && (
          <span className="dim">span {formatDuration(geometry.span)} · largest gap {formatDuration(geometry.maxGap)}</span>
        )}
        {current?.status === 'loading' && <span className="dim">loading image…</span>}
        {current?.status === 'error' && <span className="error-text">image failed: {current.error}</span>}
      </div>
    </section>
  );
}
