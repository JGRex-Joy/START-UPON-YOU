import { useMemo, useState } from 'react';
import { useStore } from '../../app/store';
import { useMarkers } from '../../hooks/useMarkers';
import { ImageViewer, type ViewerImage } from './ImageViewer';
import { NyanLoader } from '../mascot/NyanCat';
import type { EpochEntry } from '../../types';
import type { ViewState } from './viewState';

export const epochImage = (e: EpochEntry | undefined): ViewerImage | null =>
  e?.image ? { data: e.image.data, width: e.image.width, height: e.image.height, wcs: e.image.wcs } : null;

export function EpochBadge({ epoch }: { epoch: EpochEntry | undefined }) {
  if (!epoch) return null;
  const synthetic = epoch.provenance.origin === 'demo';
  return (
    <div className="epochbadge mono">
      {synthetic && <span className="badge badge--demo">SYNTHETIC</span>}
      <span>{epoch.isoDate ? epoch.isoDate.slice(0, 10) : epoch.label}</span>
      {epoch.detector && <span className="dim">{epoch.detector}</span>}
    </div>
  );
}

/** The dominant image viewer: one epoch, with candidate / catalog / target overlays. */
export function EpochViewer({ epochIndex, interactiveCandidates = true, onViewport }: { epochIndex: number; interactiveCandidates?: boolean; onViewport?: (v: ViewState, size: { w: number; h: number }) => void }) {
  const { state, actions } = useStore();
  const epoch = state.dataset?.epochs[epochIndex];
  const image = useMemo(() => epochImage(epoch), [epoch]);
  const markers = useMarkers(epoch, image);
  const [view, setView] = useState<ViewState | null>(null);

  const empty = !epoch ? null : epoch.status === 'loading' || epoch.status === 'idle'
    ? <NyanLoader label="Downloading and decoding cutout…" />
    : epoch.status === 'error'
      ? (
        <div className="viewer__error">
          <p>Could not load this exposure.</p>
          <p className="dim">{epoch.error}</p>
          <div className="stage__actions">
            <button className="btn" onClick={() => void actions.ensureEpoch(epochIndex)}>Retry</button>
            {state.dataset && epochIndex + 1 < state.dataset.epochs.length && (
              <button className="btn" onClick={() => actions.selectEpoch(epochIndex + 1)}>Try next epoch</button>
            )}
            {epoch.provenance.url && (
              <a className="btn" href={epoch.provenance.url} target="_blank" rel="noreferrer">Open cutout URL ↗</a>
            )}
          </div>
          <p className="dim stage__fine">
            Repeated 503s mean IRSA&apos;s cutout service is overloaded or down (not a problem with your coordinates). You can wait and retry,
            try another epoch, or download the cutout from the link above and load it with &ldquo;Open FITS file…&rdquo; in the left panel.
          </p>
        </div>
      )
      : null;

  return (
    <ImageViewer
      key={epoch?.id ?? 'none'}
      ariaLabel={`Image viewer${epoch ? `: ${epoch.label}` : ''}`}
      image={image}
      render={state.render}
      view={view}
      onViewChange={setView}
      onViewport={onViewport}
      markers={markers}
      showGrid={state.showGrid}
      onMarkerClick={interactiveCandidates ? (m) => { if (m.id.startsWith('c')) actions.patch({ selectedCandidate: Number(m.id.slice(1)) }); } : undefined}
      badge={<EpochBadge epoch={epoch} />}
      empty={empty}
    />
  );
}
