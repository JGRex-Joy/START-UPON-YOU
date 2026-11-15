import { useEffect, useRef, useState } from 'react';
import { CONTEXT_SURVEYS, applyBaseSurvey, loadAladin, resolveSurvey, type AladinCatalog, type AladinOverlay, type AladinStatic, type AladinView } from '../../services/aladin';
import type { SkyPosition } from '../../types';
import { NyanLoader } from '../mascot/NyanCat';
import { SkyMarkerLayer, type SkyMarker } from './SkyMarkerLayer';

export type { SkyMarker };

/** Sky footprint of the selected SPHEREx cutout, from its header WCS (SIP ignored). */
export interface SkyFootprint {
  corners: [number, number][];
  label: string;
  /** Angular distance between the requested target and the cutout's centre pixel (live searches only). */
  centreOffsetArcsec: number | null;
}

/** Optional zoom sync with the SPHEREx Image viewer (off by default; controlled by the parent). */
export interface SkySync {
  on: boolean;
  onChange: (on: boolean) => void;
  imageFovDeg: number | null;
  imageScaleArcsec: number | null;
}

interface Props {
  position: SkyPosition;
  fovDeg?: number;
  compact?: boolean;
  survey?: string;
  onSurveyChange?: (id: string) => void;
  /** Requested target position, drawn as a marker (distinct from the cutout footprint). */
  targetPos?: SkyPosition | null;
  footprint?: SkyFootprint | null;
  sync?: SkySync;
  /** Aladin projection ('AIT' shows the whole sky); default is Aladin's own (SIN). */
  projection?: string;
  /** Show Aladin's centre reticle (default: on unless compact). */
  reticle?: boolean;
  /** Labelled markers drawn over the map (the sky map's featured targets). */
  markers?: readonly SkyMarker[];
  onMarkerClick?: (id: string) => void;
  /** The user's selected position (drawn as a reticle). */
  selection?: SkyPosition | null;
  /** Called when the user clicks the map (not when they drag it). */
  onPick?: (pos: SkyPosition) => void;
  /** Smoothly pan + zoom to a position whenever `seq` changes. */
  flyTo?: { pos: SkyPosition; fovDeg: number; seq: number } | null;
  /**
   * Strip Aladin's own panels (coordinate box, projection button, settings, FoV readout) so the view is nothing but
   * sky. Zoom buttons and the attribution line stay. Used by the Observatory entry screen.
   */
  minimalChrome?: boolean;
  /** Notified once with the live Aladin view, for tests and diagnostics. */
  onReady?: (view: AladinView) => void;
}

/**
 * Aladin Lite context view. These are survey images (DSS2, 2MASS, AllWISE) shown for orientation only;
 * they are NOT SPHEREx observations and are labelled as such.
 */
export function SkyContext({ position, fovDeg = 0.25, compact = false, survey = CONTEXT_SURVEYS[0].id, onSurveyChange, targetPos = null, footprint = null, sync, projection, reticle, markers, onMarkerClick, selection = null, onPick, flyTo = null, minimalChrome = false, onReady }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<AladinView | null>(null);
  const aladin = useRef<AladinStatic | null>(null);
  const latestSurvey = useRef(survey);
  latestSurvey.current = survey;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState<string>('');
  const [providerLabel, setProviderLabel] = useState<string>('');
  const [surveyErr, setSurveyErr] = useState<string>('');
  const [aladinFov, setAladinFov] = useState<number | null>(null);
  const overlayRef = useRef<AladinOverlay | null>(null);
  const targetCat = useRef<AladinCatalog | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Load Aladin AND verify a HiPS provider first. The view is only created with a verified base URL, so Aladin never
  // falls back to its built-in CDS ID lookup (which retries forever when the CDS servers are unreachable).
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadAladin(), resolveSurvey(latestSurvey.current)])
      .then(([A, first]) => {
        if (cancelled || !host.current) return;
        aladin.current = A;
        view.current = A.aladin(host.current, {
          survey: first.provider.url, target: `${position.ra} ${position.dec}`, fov: fovDeg, cooFrame: 'ICRSd', ...(projection ? { projection } : {}),
          showReticle: reticle ?? !compact, showZoomControl: !compact, showFullscreenControl: false, showLayersControl: false,
          showGotoControl: false, showSimbadPointerControl: false, showCooGridControl: !compact && !minimalChrome, showFrame: false,
          showCooGrid: false, showStatusBar: false,
          ...(minimalChrome ? {
            showCooLocation: false, showProjectionControl: false, showSettingsControl: false, showShareControl: false,
            showSelectionModeControl: false, showFov: false, showContextMenu: false,
          } : {}),
        });
        const readFov = () => { try { const f = view.current?.getFov?.(); if (f && Number.isFinite(f[0])) setAladinFov(f[0]); } catch { /* readout only */ } };
        view.current.on?.('zoomChanged', readFov);
        readFov();
        view.current.on?.('click', (o: unknown) => {
          const e = o as { ra?: number; dec?: number; isDragging?: boolean } | undefined;
          if (!e || e.isDragging || !Number.isFinite(e.ra) || !Number.isFinite(e.dec)) return;
          onPickRef.current?.({ ra: ((e.ra as number) % 360 + 360) % 360, dec: e.dec as number });
        });
        onReadyRef.current?.(view.current);
        setProviderLabel(first.provider.label);
        setStatus('ready');
      })
      .catch((e: unknown) => { if (!cancelled) { setStatus('error'); setErr(e instanceof Error ? e.message : String(e)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { view.current?.gotoRaDec(position.ra, position.dec); }, [position.ra, position.dec]);
  useEffect(() => { view.current?.setFoV(fovDeg); }, [fovDeg]);
  // Smooth navigation: pan and zoom with Aladin's own animations (falls back to an instant jump on older builds).
  useEffect(() => {
    const v = view.current;
    if (status !== 'ready' || !v || !flyTo) return;
    if (typeof v.animateToRaDec === 'function') v.animateToRaDec(flyTo.pos.ra, flyTo.pos.dec, 1.2); else v.gotoRaDec(flyTo.pos.ra, flyTo.pos.dec);
    if (typeof v.zoomToFoV === 'function') v.zoomToFoV(flyTo.fovDeg, 1.2); else v.setFoV(flyTo.fovDeg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, flyTo?.seq]);

  // Requested target marker (a '+' at the searched position). Separate from the cutout footprint below.
  useEffect(() => {
    const v = view.current;
    const A = aladin.current;
    if (status !== 'ready' || !v || !A) return;
    if (!targetCat.current) {
      targetCat.current = A.catalog({ name: 'Requested target', shape: 'plus', sourceSize: 22, color: '#F1F4F8' });
      v.addCatalog(targetCat.current);
    }
    targetCat.current.removeAll();
    if (targetPos) targetCat.current.addSources(A.source(targetPos.ra, targetPos.dec, { name: 'Requested target' }));
  }, [status, targetPos?.ra, targetPos?.dec]);

  // Footprint of the selected SPHEREx cutout, from its header WCS (SIP ignored, so edges are approximate).
  const footprintKey = footprint ? footprint.corners.map((c) => c.join(',')).join(';') : '';
  useEffect(() => {
    const v = view.current;
    const A = aladin.current;
    if (status !== 'ready' || !v || !A || typeof A.graphicOverlay !== 'function' || typeof A.polygon !== 'function' || !v.addOverlay) return;
    if (!overlayRef.current) {
      overlayRef.current = A.graphicOverlay({ name: 'SPHEREx cutout footprint', color: '#F4A261', lineWidth: 2 });
      v.addOverlay(overlayRef.current);
    }
    const ov = overlayRef.current;
    ov.removeAll();
    if (footprint) {
      ov.add(A.polygon(footprint.corners.map((c) => [c[0], c[1]]), { color: '#F4A261', lineWidth: 2 }));
      ov.show?.();
    } else {
      ov.hide?.();
    }
  }, [status, footprintKey]);
  useEffect(() => {
    const v = view.current;
    const A = aladin.current;
    if (!v || !A) return;
    let cancelled = false;
    setSurveyErr('');
    resolveSurvey(survey)
      .then((r) => { if (!cancelled) { applyBaseSurvey(A, v, r.provider); setProviderLabel(r.provider.label); } })
      .catch((e: unknown) => { if (!cancelled) setSurveyErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [survey]);

  return (
    <div className={`skyctx ${compact ? 'skyctx--compact' : ''}`}>
      <div ref={host} className="skyctx__host" />
      {markers && (
        <SkyMarkerLayer view={status === 'ready' ? view.current : null} host={host.current} markers={markers} selection={selection} onMarkerClick={onMarkerClick} />
      )}
      {status === 'loading' && <div className="skyctx__overlay"><NyanLoader label="Loading Aladin Lite…" /></div>}
      {status === 'error' && (
        <div className="skyctx__overlay skyctx__overlay--error">
          <p className="skyctx__title">Survey context unavailable</p>
          <p className="skyctx__text">{err}</p>
          <p className="skyctx__text dim">The SPHEREx image viewer does not depend on Aladin. This panel needs a connection to a HiPS survey provider (ESA Sky, NASA/IPAC IRSA or CDS).</p>
        </div>
      )}
      {!compact && (targetPos || footprint || sync) && (
        <div className="skyctx__legend mono">
          {targetPos && <div><span className="skyctx__sw skyctx__sw--target" />Requested target · RA {targetPos.ra.toFixed(5)}° Dec {targetPos.dec.toFixed(5)}°</div>}
          {footprint && (
            <div>
              <span className="skyctx__sw skyctx__sw--fp" />SPHEREx cutout footprint ({footprint.label}) · header WCS, SIP ignored: edges approximate
              {footprint.centreOffsetArcsec !== null && ` · cutout centre is ${footprint.centreOffsetArcsec.toFixed(1)}″ from the target`}
            </div>
          )}
          {sync && (
            <div>
              Sky view FoV {aladinFov !== null ? `${aladinFov.toFixed(4)}°` : '—'} (horizontal) · Image viewer {sync.imageFovDeg !== null ? `${sync.imageFovDeg.toFixed(4)}°` : '—'}
              {sync.imageScaleArcsec !== null && ` · SPHEREx ${sync.imageScaleArcsec.toFixed(2)}″/px`}
            </div>
          )}
          {sync?.on && (
            <div className="dim">
              {sync.imageFovDeg !== null
                ? 'Sync is approximate: the Image viewer is detector-oriented, this map is north-up, SIP is ignored and the wavelength differs. Not pixel-aligned.'
                : 'Sync is on, but no SPHEREx image is loaded: using the default 0.25° field.'}
            </div>
          )}
        </div>
      )}
      {surveyErr && !compact && (
        <p className="skyctx__text dim" style={{ position: 'absolute', left: 12, right: 12, bottom: 44, margin: 0, zIndex: 3 }}>
          {surveyErr} Keeping the previous background.
        </p>
      )}
      <div className="skyctx__credit mono">
        Context survey (not SPHEREx) · {providerLabel ? `${providerLabel} · ` : ''}Aladin Lite
      </div>
      {!compact && sync && (
        <div className="skyctx__sync">
          <button
            className={`chip ${sync.on ? 'is-active' : ''}`} role="switch" aria-checked={sync.on}
            title="Match this map's field of view to the SPHEREx Image viewer's current zoom (approximate)"
            onClick={() => sync.onChange(!sync.on)}
          >Sync zoom with Image</button>
        </div>
      )}
      {!compact && onSurveyChange && (
        <div className="skyctx__surveys" role="radiogroup" aria-label="Context survey">
          {CONTEXT_SURVEYS.map((s) => (
            <button key={s.id} role="radio" aria-checked={survey === s.id} className={`chip ${survey === s.id ? 'is-active' : ''}`} onClick={() => onSurveyChange(s.id)}>{s.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
