import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../app/store';
import type { StageTab } from '../app/store';
import type { ChallengeTarget, SkyPosition } from '../types';
import { CoordinateSearch } from '../components/navigation/CoordinateSearch';
import { TargetSelector } from '../components/navigation/TargetSelector';
import { EpochViewer } from '../components/sky/EpochViewer';
import { ImageViewer } from '../components/sky/ImageViewer';
import { SkyContext } from '../components/sky/SkyContext';
import { CompareView } from '../components/comparison/CompareView';
import { EpochTimeline } from '../components/timeline/EpochTimeline';
import { ChannelSelector } from '../components/spectral/ChannelSelector';
import { ProvenancePanel } from '../components/analysis/ProvenancePanel';
import { CatalogPanel } from '../components/analysis/CatalogPanel';
import { DisplaySettings } from '../components/layout/DisplaySettings';
import { NyanLoader, NyanCat } from '../components/mascot/NyanCat';
import { CONTEXT_SURVEYS } from '../services/aladin';
import { ALLSKY_IMAGE_MB, allSkyTile } from '../services/spherex/allSkyCube';
import { formatDecDms, formatRaHms, separationArcsec } from '../utils/coords';
import { imageFootprint, pixelScaleArcsec, pixelToSky } from '../services/fits/wcs';
import type { ViewState } from '../components/sky/viewState';

const TABS: { id: StageTab; label: string; note: string }[] = [
  { id: 'image', label: 'Image', note: 'The actual observation at your position — one exposure at a time.' },
  { id: 'compare', label: 'Compare', note: 'Two observations side by side, labelled with the dates recorded for each.' },
  { id: 'spectral', label: 'Spectral', note: 'The same spot across SPHEREx\u2019s wavelength channels.' },
  { id: 'sky', label: 'Sky context', note: 'Where your target sits among other surveys and catalogues.' },
];

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rail__section">
      <button className="rail__title" aria-expanded={open} onClick={() => setOpen(!open)}><span>{title}</span><span aria-hidden="true">{open ? '−' : '+'}</span></button>
      {open && <div className="rail__body">{children}</div>}
    </section>
  );
}

/** Empty Spectral tab. Level-2 exposures are not cubes; for live data the real DR1 All-Sky Cube tile is loaded on demand from AWS. */
function CubeEmpty() {
  const { state, actions } = useStore();
  const { allSky, target, dataset } = state;
  const canLoad = !!target && dataset?.origin === 'spherex-live';
  const tile = canLoad && target ? allSkyTile(target.searchPos).npix : null;
  const pct = allSky.total ? Math.min(100, (allSky.received / allSky.total) * 100) : null;
  const mb = (n: number) => (n / 1e6).toFixed(0);
  // Auto-start: the tile is located and downloaded as soon as the Spectral tab is shown (cancel stays available).
  // Only from 'idle': after an error or a cancel it waits for the user, so there is no retry loop.
  useEffect(() => { if (canLoad && allSky.status === 'idle') void actions.loadAllSkyCube(); }, [canLoad, allSky.status, actions]);
  const busy = allSky.status === 'discovering' || allSky.status === 'downloading' || allSky.status === 'validating';
  return (
    <div className="stage__empty">
      <p className="stage__empty-title">No spectral cube loaded</p>
      <p className="dim">
        Individual SPHEREx exposures (Level 2) have no channel slices and are not spectral cubes.
        {canLoad ? ' The DR1 All-Sky Cube is a separate archive product with 102 real spectral channels per sky tile, read directly from the public AWS bucket.' : ' Open a cube FITS file, or try the demo.'}
      </p>
      {canLoad && (
        <div className="allsky">
          {busy && (
            <>
              <progress className="allsky__bar" max={100} value={pct ?? undefined} aria-label="All-Sky Cube progress" />
              <p className="mono allsky__stage" aria-live="polite">{allSky.stage}{pct !== null ? ` ${pct.toFixed(0)}%` : ''}</p>
              <button className="btn" onClick={actions.cancelAllSkyCube}>Cancel</button>
            </>
          )}
          {allSky.status === 'awaiting_download_authorization' && allSky.plan && (
            <>
              <p className="allsky__stage" role="status">
                Tile {allSky.plan.tile.npix} found on AWS: {allSky.plan.shape.join('×')} cube. Download <strong>{mb(allSky.plan.downloadBytes)} MB</strong>
                {allSky.plan.fileBytes ? ` (the full file is ${mb(allSky.plan.fileBytes)} MB; NHITS and FLAGS are skipped)` : ''} using {allSky.plan.transport === 'range' ? 'HTTP Range requests' : 'a stream (the server ignores Range)'}?
              </p>
              <div className="stage__actions">
                <button className="btn btn--primary" onClick={actions.authorizeAllSkyDownload}>Download {mb(allSky.plan.downloadBytes)} MB</button>
                <button className="btn" onClick={actions.cancelAllSkyCube}>Cancel</button>
              </div>
            </>
          )}
          {!busy && allSky.status !== 'awaiting_download_authorization' && (
            <button className="btn btn--primary" onClick={() => void actions.loadAllSkyCube()}>
              {allSky.status === 'error' || allSky.status === 'cancelled' ? 'Try again: ' : ''}Find DR1 All-Sky Cube tile{tile !== null ? ` ${tile}` : ''} on AWS
            </button>
          )}
          <p className="dim allsky__note">
            HEALPix order-5 tile (about 1.8° square, 512×512 px, 102 channels) for your target. It opens automatically: only the headers and one channel (~1 MB) are fetched now; other channels load when you open them (the whole IMAGE layer is ≈{ALLSKY_IMAGE_MB} MB). Real NASA data only: nothing is simulated.
          </p>
          {allSky.status === 'cancelled' && <p className="dim" role="status">Cancelled. Nothing was kept from the unfinished download.</p>}
          {allSky.status === 'error' && <p className="allsky__err" role="alert">{allSky.message}</p>}
        </div>
      )}
    </div>
  );
}

function CubeViewer() {
  const { state, actions } = useStore();
  const cube = state.dataset?.cube;
  const info = state.dataset?.cubeInfo;
  const [view, setView] = useState<ViewState | null>(null);
  const blank = !!cube?.blankChannels?.includes(state.channel);
  const lazyPending = !!cube?.lazy && !blank && !cube.lazy.isLoaded(state.channel);
  // On-demand cube: fetch the shown channel (and its neighbours) as soon as it is selected.
  useEffect(() => { if (cube?.lazy) void actions.ensureChannel(state.channel); }, [cube, state.channel, actions]);
  const image = useMemo(() => (cube && !blank && !lazyPending ? { data: cube.readSlice(state.channel), width: cube.width, height: cube.height, wcs: cube.wcs } : null), [cube, state.channel, blank, lazyPending, state.cubeTick]);
  const chErr = state.channelError && state.channelError.channel === state.channel ? state.channelError.message : null;
  const wl = cube?.wavelengthsUm?.[state.channel];
  return (
    <ImageViewer
      ariaLabel="Spectral channel viewer" image={image} render={state.render} view={view} onViewChange={setView} showGrid={state.showGrid}
      badge={cube ? <div className="epochbadge mono">{state.dataset?.origin === 'demo' && <span className="badge badge--demo">SYNTHETIC</span>}{info && <span className="badge badge--live">DR1 ALL-SKY CUBE{info.tile !== null ? ` · Npix${info.tile}` : ''}</span>}<span>channel {state.channel + 1}/{cube.depth}</span>{wl != null && <span className="dim">{wl.toFixed(3)} µm</span>}</div> : null}
      empty={cube && lazyPending
        ? <div className="stage__empty">
            <p className="stage__empty-title">{chErr ? `Channel ${state.channel + 1} could not be loaded` : `Loading channel ${state.channel + 1}…`}</p>
            {chErr
              ? <><p className="allsky__err" role="alert">{chErr}</p><button className="btn btn--primary" onClick={() => void actions.ensureChannel(state.channel)}>Retry</button></>
              : <p className="dim">Only this channel (~{((cube.lazy!.bytesPerChannel) / 1e6).toFixed(1)} MB) is fetched from AWS with an HTTP Range request.</p>}
          </div>
        : cube
        ? <div className="stage__empty"><p className="stage__empty-title">Channel {state.channel + 1} has no data</p><p className="dim">This channel is blank in the cube{info ? ' (the SPHEREx channels next to the dichroic beam splitter are kept only so channel numbering and spacing stay correct)' : ''}. It is not shown as zero flux. Step to a neighbouring channel with [ and ].</p></div>
        : <CubeEmpty />}
    />
  );
}

export function ExplorerPage({ goAnalysis }: { goAnalysis: () => void }) {
  const { state, actions } = useStore();
  const { dataset, phase, target, tab } = state;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [survey, setSurvey] = useState<string>(CONTEXT_SURVEYS[0].id);
  const busy = phase === 'searching';
  const [syncZoom, setSyncZoom] = useState(false);
  // Last Image-viewer zoom/viewport, kept in a ref (no re-render on every wheel tick); read when Sky context mounts.
  const imgViewport = useRef<{ zoom: number; w: number } | null>(null);
  const onImgViewport = useCallback((v: ViewState, s: { w: number; h: number }) => { imgViewport.current = { zoom: v.zoom, w: s.w }; }, []);
  const nEpochs = dataset?.epochs.length ?? 0;
  const ep = dataset?.epochs[state.epochIndex];
  const pos: SkyPosition = target?.searchPos ?? { ra: 133.795129, dec: -7.245147 };
  const epImg = ep?.image;
  const epWcs = epImg?.wcs ?? null;
  const isLive = dataset?.origin === 'spherex-live';
  const imageScale = epWcs ? pixelScaleArcsec(epWcs) : null;
  // Horizontal sky span currently visible in the Image viewer (degrees); null when there is no usable WCS/viewport.
  const vp = imgViewport.current;
  const imageFovDeg = imageScale && vp && vp.zoom > 0 && vp.w > 0 ? Math.min(20, Math.max(0.002, ((vp.w / vp.zoom) * imageScale) / 3600)) : null;
  const footprint = useMemo(() => {
    if (!epImg || !epWcs || dataset?.origin === 'demo') return null;
    const centre = pixelToSky(epWcs, (epImg.width - 1) / 2, (epImg.height - 1) / 2);
    return {
      corners: imageFootprint(epWcs, epImg.width, epImg.height),
      label: ep?.isoDate?.slice(0, 10) ?? ep?.label ?? 'selected epoch',
      centreOffsetArcsec: isLive ? separationArcsec({ ra: pos.ra, dec: pos.dec }, centre) : null,
    };
  }, [epImg, epWcs, dataset?.origin, isLive, ep?.isoDate, ep?.label, pos.ra, pos.dec]);
  const epochCoverage = useMemo(() => {
    if (!dataset) return null;
    const dated = dataset.epochs.filter((e) => e.mjd !== null);
    return { n: dataset.epochs.length, dated: dated.length, first: dated[0]?.isoDate?.slice(0, 10), last: dated[dated.length - 1]?.isoDate?.slice(0, 10) };
  }, [dataset]);

  // Make sure the first epoch is requested when arriving with data but no image yet.
  useEffect(() => { if (dataset && dataset.epochs.length && ep?.status === 'idle') void actions.ensureEpoch(state.epochIndex); }, [dataset, ep?.status, state.epochIndex, actions]);

  // Arriving from the sky map (or any tool) with a shared target but no data yet: load it, never ask for it again.
  useEffect(() => {
    if (target && !dataset && phase === 'idle') void actions.search(target.pos, target.name, target.challenge);
  }, [target, dataset, phase, actions]);

  const pickTarget = (t: ChallengeTarget) => void actions.search({ ra: t.ra, dec: t.dec }, t.name, t);

  const stage = (() => {
    if (busy) return <div className="stage__empty"><NyanLoader label={state.message ?? 'Working…'} /></div>;
    if (phase === 'error') {
      return (
        <div className="stage__empty">
          <p className="stage__empty-title">Couldn’t load SPHEREx data</p>
          <p className="stage__msg">{state.message}</p>
          <div className="stage__actions">
            <button className="btn" onClick={() => target && void actions.search(target.pos, target.name, target.challenge)}>Try again</button>
            <button className="btn btn--primary" onClick={actions.startDemo}>Use demonstration data</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>Open FITS file…</button>
          </div>
          <p className="dim stage__fine">Demonstration data is synthetic and always labelled as such. It is never presented as a SPHEREx observation.</p>
        </div>
      );
    }
    if (!dataset && tab !== 'sky') {
      return (
        <div className="stage__empty stage__empty--idle">
          <NyanCat height={44} />
          <p className="stage__empty-title">Choose where to look</p>
          <p className="dim">Enter RA/Dec or pick a challenge target. The Explorer queries NASA/IPAC IRSA for SPHEREx exposures covering that position and shows only the epochs that exist.</p>
          <div className="stage__actions"><button className="btn" onClick={actions.startDemo}>Try the labelled demo</button><button className="btn" onClick={() => fileRef.current?.click()}>Open FITS file…</button></div>
        </div>
      );
    }
    if (tab === 'sky') {
      return (
        <SkyContext
          position={pos} fovDeg={syncZoom && imageFovDeg !== null ? imageFovDeg : 0.25} survey={survey} onSurveyChange={setSurvey}
          targetPos={isLive && target ? target.searchPos : null} footprint={footprint}
          sync={{ on: syncZoom, onChange: setSyncZoom, imageFovDeg, imageScaleArcsec: imageScale }}
        />
      );
    }
    if (tab === 'compare') return <CompareView />;
    if (tab === 'spectral') return <CubeViewer />;
    if (dataset && nEpochs === 0 && dataset.cube) return <CubeViewer />;
    return <EpochViewer epochIndex={state.epochIndex} interactiveCandidates={false} onViewport={onImgViewport} />;
  })();

  return (
    <div className="explorer">
      <aside className="rail rail--left" aria-label="Search and display">
        <Section title="Position">
          <CoordinateSearch idPrefix="ex" size="compact" initial={target?.pos ?? null} busy={busy} submitLabel="Go"
            onSubmit={(p) => void actions.search(p)} />
          {target && (
            <div className="selected mono" aria-live="polite">
              <div className="selected__name">{target.name}</div>
              <div>{formatRaHms(target.pos.ra)} {formatDecDms(target.pos.dec)}</div>
              <div className="dim">{target.pos.ra.toFixed(5)}°, {target.pos.dec.toFixed(5)}°</div>
              {target.propagated && <div className="dim">searched at {target.searchPos.ra.toFixed(5)}°, {target.searchPos.dec.toFixed(5)}° (proper motion to 2026.0)</div>}
            </div>
          )}
        </Section>
        <Section title="Challenge targets">
          <TargetSelector activeId={target?.challenge?.id ?? null} onSelect={pickTarget} disabled={busy} />
          {target?.challenge && (
            <div className="targetinfo">
              <p>{target.challenge.note}</p>
              <p className="dim mono">Position: {target.challenge.precision}. Source: <a href={target.challenge.source.url} target="_blank" rel="noreferrer">{target.challenge.source.label}</a></p>
            </div>
          )}
        </Section>
        <Section title="Display" defaultOpen={false}><DisplaySettings /></Section>
        <Section title="Data" defaultOpen={false}>
          <div className="panelstack">
            <button className="btn" onClick={() => fileRef.current?.click()}>Open FITS file…</button>
            <button className="btn" onClick={actions.startDemo}>Load labelled demo</button>
            <input ref={fileRef} type="file" accept=".fits,.fit,.fts,.fits.gz" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void actions.loadFile(f); e.target.value = ''; }} />
            <p className="dim catalog__caveat">Gzip-compressed files are not supported in this prototype; decompress first.</p>
          </div>
        </Section>
      </aside>

      <main className="stage" aria-label="Sky viewer">
        <div className="stage__tabs" role="tablist" aria-label="View">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`stage__tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => actions.patch({ tab: t.id })}>{t.label}</button>
          ))}
          <span className="stage__tabs-spacer" />
          {dataset && <button className="btn btn--ghost" onClick={goAnalysis}>Analysis tools →</button>}
        </div>
        <p className="toolnote"><img src={`${import.meta.env.BASE_URL}nyan-cat.png`} alt="" /><span><b>{TABS.find((t) => t.id === tab)?.label}</b> — {TABS.find((t) => t.id === tab)?.note}</span></p>
        <div className="stage__body">{stage}</div>
        <div className="stage__dock">
          {tab === 'spectral' || (dataset && nEpochs === 0 && dataset.cube) ? <ChannelSelector /> : <EpochTimeline />}
        </div>
      </main>

      <aside className="rail rail--right" aria-label="Inspector">
        <Section title="Observation & provenance"><ProvenancePanel /></Section>
        {epochCoverage && (
          <Section title="Coverage" defaultOpen>
            <p className="coverage mono">
              {epochCoverage.n} {epochCoverage.n === 1 ? 'epoch' : 'epochs'}
              {epochCoverage.first && epochCoverage.last ? ` · ${epochCoverage.first} → ${epochCoverage.last}` : ' · undated'}
            </p>
            {epochCoverage.n < 2 && <p className="notice notice--warn">Insufficient temporal coverage for comparison.</p>}
          </Section>
        )}
        <Section title="Catalog overlays" defaultOpen={false}><CatalogPanel /></Section>
      </aside>
    </div>
  );
}
