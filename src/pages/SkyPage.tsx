import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../app/store';
import { parseRoute } from '../app/router';
import { buildSkyHash, parseSkyHash, type SkySelection } from '../app/skyUrl';
import { SkyContext, type SkyMarker } from '../components/sky/SkyContext';
import { ObjectInspector } from '../components/observatory/ObjectInspector';
import { FindByCoordinates } from '../components/observatory/FindByCoordinates';
import { NyanCompanion } from '../components/observatory/NyanCompanion';
import { Bubble } from '../components/welcome/Bubble';
import { ENTRY_TIMING, TOUR_TEXT } from '../app/entry';
import { CONTEXT_SURVEYS } from '../services/aladin';
import { CHALLENGE_TARGETS, FOCUS_LABEL } from '../services/targets';
import type { ChallengeTarget, SkyPosition } from '../types';

/** All-sky starting view (Aitoff projection: the whole sky spans a 360° horizontal field). */
const ALLSKY_FOV = 360;
const ALLSKY_CENTRE: SkyPosition = { ra: 180, dec: 0 };
/** Field of view when flying to a chosen target / coordinates (degrees). */
const TARGET_FOV = 4;
/** If Aladin never reports in (blocked CDN, offline), the companion still greets after this long. */
const MAP_READY_FALLBACK_MS = 5000;

const MARKERS_BASE = CHALLENGE_TARGETS.map((t) => ({ id: t.id, name: t.name, pos: { ra: t.ra, dec: t.dec }, focus: t.focus, detail: FOCUS_LABEL[t.focus] }));

function currentHashSelection(): { selection: SkySelection | null; error: string | null } {
  const r = parseSkyHash(window.location.hash);
  return r.kind === 'ok' ? { selection: r.selection, error: null } : { selection: null, error: r.kind === 'invalid' ? r.error : null };
}

/**
 * Scene 4 — the sky, and almost nothing else. No header, no dock, no search box and no inspector until something is
 * selected; the controls live behind the Nyan Cat companion at the edge. Selection is NOT local state: it is the shared
 * research target in the store (`state.target`), so Explorer, Spectral, timeline and Analysis open on what was chosen here.
 */
export function SkyPage({ goExplorer, goAbout, goAnalysis, entered, onReplayIntro, onStartTour, offerTour, reducedMotion = false }: {
  goExplorer: () => void;
  goAbout: () => void;
  goAnalysis: () => void;
  entered: boolean;
  onReplayIntro: () => void;
  /** Begin the guided Explorer tour. */
  onStartTour?: () => void;
  /** Whether the companion should offer it (false once the tour has been seen). */
  offerTour?: boolean;
  reducedMotion?: boolean;
}) {
  const { state, actions } = useStore();
  const target = state.target;
  const selection: SkySelection | null = useMemo(() => (target ? { pos: target.pos, challenge: target.challenge } : null), [target]);
  const [inspectorOpen, setInspectorOpen] = useState(!!target);
  const [controls, setControls] = useState(false);
  const [coordsOpen, setCoordsOpen] = useState(false);
  const [survey, setSurvey] = useState<string>(CONTEXT_SURVEYS[0].id);
  const [flyTo, setFlyTo] = useState<{ pos: SkyPosition; fovDeg: number; seq: number } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(() => currentHashSelection().error);
  const [mapReady, setMapReady] = useState(false);
  const [invite, setInvite] = useState(false);
  const [inviteGone, setInviteGone] = useState(false);
  const seq = useRef(0);
  // The map is created once; these are its starting point (the current target if there is one, else the whole sky).
  const [start] = useState(() => {
    const fromUrl = currentHashSelection().selection;
    const p = fromUrl?.pos ?? target?.pos ?? null;
    return p ? { pos: p, fov: TARGET_FOV } : { pos: ALLSKY_CENTRE, fov: ALLSKY_FOV };
  });

  useEffect(() => {
    const id = window.setTimeout(() => setMapReady(true), MAP_READY_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, []);

  // Let the visitor actually look at the sky first, then offer the next step rather than forcing it.
  useEffect(() => {
    if (!entered || !offerTour || inviteGone) return;
    const id = window.setTimeout(() => setInvite(true), ENTRY_TIMING.skyHint);
    return () => window.clearTimeout(id);
  }, [entered, offerTour, inviteGone]);

  const choose = useCallback((pos: SkyPosition, challenge: ChallengeTarget | null, fly: boolean) => {
    actions.selectTarget(pos, challenge?.name, challenge);
    setInspectorOpen(true);
    setLinkError(null);
    if (fly) setFlyTo({ pos, fovDeg: TARGET_FOV, seq: ++seq.current });
  }, [actions]);

  // A link such as #/sky?t=barnards-star selects that target on arrival (and when the hash is edited while on the page).
  useEffect(() => {
    const apply = () => {
      const { selection: s, error } = currentHashSelection();
      setLinkError(error);
      if (s) choose(s.pos, s.challenge, true);
    };
    const initial = currentHashSelection().selection;
    if (initial && !(target && target.pos.ra === initial.pos.ra && target.pos.dec === initial.pos.dec)) choose(initial.pos, initial.challenge, false);
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL in step with the shared target (replaceState: no history entry per click, no hashchange loop).
  // Only while this page is still the active route: leaving for #/explorer must not be overwritten by a late effect.
  const urlKey = selection ? buildSkyHash(selection) : null;
  useEffect(() => {
    if (urlKey && parseRoute(window.location.hash) === 'sky' && window.location.hash !== urlKey) window.history.replaceState(null, '', urlKey);
  }, [urlKey]);

  const markers: SkyMarker[] = useMemo(() => MARKERS_BASE.map((m) => ({ ...m, active: target?.challenge?.id === m.id })), [target?.challenge?.id]);
  const pickMarker = (id: string) => { const t = CHALLENGE_TARGETS.find((x) => x.id === id); if (t) choose({ ra: t.ra, dec: t.dec }, t, true); };
  const allSky = () => setFlyTo({ pos: ALLSKY_CENTRE, fovDeg: ALLSKY_FOV, seq: ++seq.current });
  const explore = () => {
    if (!target) return;
    void actions.search(target.pos, target.name, target.challenge);
    goExplorer();
  };

  return (
    <div className={`skypage ${coordsOpen ? 'coords-open' : ''}`} data-testid="sky-page">
      <SkyContext
        position={start.pos} fovDeg={start.fov} projection="AIT" reticle={false}
        survey={survey} onSurveyChange={controls ? setSurvey : undefined}
        markers={markers} onMarkerClick={pickMarker}
        selection={selection?.pos ?? null}
        onPick={(p) => choose(p, null, false)}
        flyTo={flyTo}
        minimalChrome
        onReady={() => setMapReady(true)}
      />

      {(controls || linkError) && (
        <div className="skypage__top">
          {controls && (
            <div className="skypage__bar">
              <FindByCoordinates open={coordsOpen} onOpenChange={setCoordsOpen} initial={selection?.pos ?? null} onSubmit={(p) => choose(p, null, true)} />
              <button className="findcoord__btn" data-testid="all-sky" onClick={allSky}>All sky</button>
            </div>
          )}
          {linkError && <p className="skypage__notice" role="alert">{linkError} <button className="linkbtn" onClick={() => setLinkError(null)}>Dismiss</button></p>}
        </div>
      )}

      {inspectorOpen && selection && (
        <ObjectInspector selection={selection} onExplore={explore} onClose={() => setInspectorOpen(false)} />
      )}

      <NyanCompanion
        mapReady={mapReady && entered} open={controls} onOpenChange={setControls} instant={reducedMotion}
        invite={invite && !inviteGone ? (
          <Bubble text={TOUR_TEXT.skyNext} tail="down" instant={reducedMotion} speed={22} className="companion__greeting" testId="companion-invite">
            <button className="tour__next" data-testid="start-tour" onClick={() => { setInviteGone(true); onStartTour?.(); }}>Show me</button>
            <button className="tour__skip" onClick={() => { setInvite(false); setInviteGone(true); }}>Not now</button>
          </Bubble>
        ) : null}
      >
        <p className="companion__lead">The sky is yours. Click a marker, or anywhere else, to inspect that position.</p>
        <div className="companion__group" role="group" aria-label="Featured SPHEREx targets">
          <p className="companion__h">Featured targets</p>
          <div className="companion__row">
            {CHALLENGE_TARGETS.map((t) => (
              <button key={t.id} className={`companion__link ${target?.challenge?.id === t.id ? 'is-active' : ''}`} data-testid={`target-${t.id}`} onClick={() => pickMarker(t.id)} title={FOCUS_LABEL[t.focus]}>
                <i className={`keyglyph keyglyph--${t.focus}`} aria-hidden="true" />{t.name}
              </button>
            ))}
          </div>
          <p className="companion__key"><i className="keyglyph keyglyph--motion" /> motion <i className="keyglyph keyglyph--variability" /> variability <i className="keyglyph keyglyph--sel" /> selected</p>
        </div>
        <div className="companion__row">
          <button className="companion__link" onClick={() => { setControls(false); allSky(); }}>Back to the whole sky</button>
          <button className="companion__link" onClick={goExplorer}>Observatory workspace</button>
          <button className="companion__link" onClick={goAnalysis}>Analysis</button>
          <button className="companion__link" onClick={goAbout}>About the project</button>
          <button className="companion__link" data-testid="replay-intro" onClick={() => { setControls(false); onReplayIntro(); }}>Replay the intro</button>
        </div>
      </NyanCompanion>
    </div>
  );
}
