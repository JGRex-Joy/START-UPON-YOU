import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type {
  CatalogId, CatalogSource, ChallengeTarget, CubeInfo, Dataset, DetectionResult, EpochEntry, SkyPosition,
} from '../types';
import { DEFAULT_RENDER, type RenderOptions } from '../engines/imageProcessing';
import { DEFAULT_DETECTION, type DetectionOptions } from '../engines/sourceDetection';
import { loadEpochImage, headerObservationTime } from '../services/spherex';
import { discoverEpochs } from '../services/spherex/discovery';
import { CancelledError } from '../services/aws/errors';
import { AllSkyCubeSession, type CubeLoadState, type CubeLoadStatus } from '../services/aws/cubeSession';
import { CATALOG_SERVICES } from '../services/catalog';
import { makeDemoDataset } from '../services/demo/syntheticSky';
import { findHdu, parseFits, pickScienceHdu, toFitsImage, toSpectralCube } from '../services/fits';
import { buildAllSkyCube, isAllSkyImageHdu, type DownloadPlan } from '../services/spherex/allSkyCube';
import { propagate } from '../utils/coords';
import { analysis } from '../workers/analysisClient';

/** Mid-mission reference epoch used to move fast-moving targets to where SPHEREx actually saw them. */
export const SPHEREX_REF_EPOCH = 2026.0;

export interface Target {
  name: string;
  /** Position as entered / catalogued (J2000 for challenge targets). */
  pos: SkyPosition;
  /** Position actually searched (proper-motion propagated when known). */
  searchPos: SkyPosition;
  challenge: ChallengeTarget | null;
  propagated: boolean;
}

export type LoadPhase = 'idle' | 'searching' | 'ready' | 'error';
export type StageTab = 'image' | 'compare' | 'spectral' | 'sky';

/**
 * State of the optional real All-Sky Cube load (separate from the epoch search; needs only AWS, never IRSA).
 * Mirrors the typed session states: idle → discovering → awaiting_download_authorization → downloading → validating →
 * loaded | error | cancelled.
 */
export interface AllSkyLoad {
  status: CubeLoadStatus;
  message: string | null;
  stage: string;
  received: number;
  total: number | null;
  /** What would be downloaded; set while awaiting authorisation. */
  plan: DownloadPlan | null;
}
export const IDLE_ALLSKY: AllSkyLoad = { status: 'idle', message: null, stage: '', received: 0, total: null, plan: null };

function allSkyFromSession(s: CubeLoadState): AllSkyLoad {
  switch (s.status) {
    case 'discovering': return { ...IDLE_ALLSKY, status: s.status, stage: s.stage };
    case 'awaiting_download_authorization': return { ...IDLE_ALLSKY, status: s.status, plan: s.plan };
    case 'downloading': return { ...IDLE_ALLSKY, status: s.status, stage: s.stage, received: s.received, total: s.total };
    case 'validating': return { ...IDLE_ALLSKY, status: s.status, stage: s.stage };
    case 'error': return { ...IDLE_ALLSKY, status: s.status, message: s.message };
    default: return { ...IDLE_ALLSKY, status: s.status };
  }
}

export interface CatalogLayer {
  enabled: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  sources: CatalogSource[];
  error?: string;
}

export interface State {
  target: Target | null;
  phase: LoadPhase;
  message: string | null;
  dataset: Dataset | null;
  epochIndex: number;
  compareIndex: number;
  channel: number;
  tab: StageTab;
  playing: boolean;
  speed: number;
  bandFilter: string;
  render: RenderOptions;
  showGrid: boolean;
  catalogs: Record<CatalogId, CatalogLayer>;
  detection: Record<string, DetectionResult>;
  detectOpts: DetectionOptions;
  detectBusy: boolean;
  detectError: string | null;
  selectedCandidate: number | null;
  lastDiscovery: number;
  allSky: AllSkyLoad;
  /** On-demand cube: bumped whenever a channel plane arrives (cube.slices is mutated in place). */
  cubeTick: number;
  /** 0-based channels being fetched right now. */
  loadingChannels: number[];
  channelError: { channel: number; message: string } | null;
  /** Progress of 'load all channels'. */
  bulk: { done: number; total: number } | null;
}

const emptyLayer = (): CatalogLayer => ({ enabled: false, status: 'idle', sources: [] });

const initial: State = {
  target: null, phase: 'idle', message: null, dataset: null,
  epochIndex: 0, compareIndex: 1, channel: 0, tab: 'image', playing: false, speed: 1, bandFilter: 'all',
  render: DEFAULT_RENDER, showGrid: true,
  catalogs: { 'gaia-dr3': emptyLayer(), allwise: emptyLayer() },
  detection: {}, detectOpts: DEFAULT_DETECTION, detectBusy: false, detectError: null, selectedCandidate: null,
  lastDiscovery: 0, allSky: IDLE_ALLSKY,
  cubeTick: 0, loadingChannels: [], channelError: null, bulk: null,
};

type Patch = Partial<State> | ((s: State) => Partial<State>);
const reducer = (s: State, p: Patch): State => ({ ...s, ...(typeof p === 'function' ? p(s) : p) });

/** Build the shared research target. Challenge targets with a known proper motion are searched at their 2026.0 position. */
export function makeTarget(pos: SkyPosition, name?: string, challenge: ChallengeTarget | null = null): Target {
  const moved = !!challenge && challenge.pmRa !== null && challenge.pmDec !== null;
  const searchPos = moved ? propagate(pos, challenge.pmRa, challenge.pmDec, SPHEREX_REF_EPOCH - 2000) : pos;
  return { name: name ?? `${pos.ra.toFixed(4)}, ${pos.dec.toFixed(4)}`, pos, searchPos, challenge, propagated: moved };
}

export interface Actions {
  /**
   * Make a sky position the shared research target WITHOUT querying any archive (no IRSA call). Used by the sky map.
   * Clears data that belongs to the previous target; does nothing if the same position is already the target.
   */
  selectTarget(pos: SkyPosition, name?: string, challenge?: ChallengeTarget | null): void;
  search(pos: SkyPosition, name?: string, challenge?: ChallengeTarget | null): Promise<void>;
  startDemo(): void;
  loadFile(file: File): Promise<void>;
  /** Locate the real DR1 All-Sky Cube tile for the current target on AWS and report its size; downloads only after authorisation. */
  loadAllSkyCube(): Promise<void>;
  /** The user agreed to the download described in `allSky.plan`. */
  authorizeAllSkyDownload(): void;
  cancelAllSkyCube(): void;
  selectEpoch(i: number): void;
  selectCompare(i: number): void;
  ensureEpoch(i: number): Promise<EpochEntry | null>;
  setChannel(c: number): void;
  /** On-demand cube: fetch channel `c` (~1 MB, HTTP Range) and its neighbours. No-op for fully loaded cubes. */
  ensureChannel(c: number): Promise<void>;
  /** On-demand cube: fetch every remaining channel (parallel, cancellable by changing target). */
  loadAllChannels(): Promise<void>;
  patch(p: Patch): void;
  toggleCatalog(id: CatalogId): void;
  runDetection(epochIndex: number): Promise<void>;
  visibleIndices(): number[];
}

interface Ctx { state: State; actions: Actions }
const StoreContext = createContext<Ctx | null>(null);

export function useStore(): Ctx {
  const c = useContext(StoreContext);
  if (!c) throw new Error('useStore must be used inside <StoreProvider>');
  return c;
}

export function visibleIndicesOf(s: State): number[] {
  const eps = s.dataset?.epochs ?? [];
  const out: number[] = [];
  eps.forEach((e, i) => { if (s.bandFilter === 'all' || e.detector === s.bandFilter) out.push(i); });
  return out;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const ref = useRef(state);
  ref.current = state;
  const inflight = useRef(new Map<string, Promise<EpochEntry | null>>());
  const searchToken = useRef(0);
  const cubeSession = useRef<AllSkyCubeSession | null>(null);
  if (!cubeSession.current) cubeSession.current = new AllSkyCubeSession();

  const patch = useCallback((p: Patch) => dispatch(p), []);

  const updateEpoch = useCallback((id: string, upd: Partial<EpochEntry>) => {
    dispatch((s) => s.dataset
      ? { dataset: { ...s.dataset, epochs: s.dataset.epochs.map((e) => (e.id === id ? { ...e, ...upd } : e)) } }
      : {});
  }, []);

  const ensureEpoch = useCallback(async (i: number): Promise<EpochEntry | null> => {
    const ep = ref.current.dataset?.epochs[i];
    if (!ep) return null;
    if (ep.status === 'ready') return ep;
    const running = inflight.current.get(ep.id);
    if (running) return running;
    updateEpoch(ep.id, { status: 'loading', error: undefined });
    const p = (async () => {
      try {
        const { image, headerDate, notes: loadNotes } = await loadEpochImage(ep, ref.current.target?.searchPos);
        const notes = [...(ep.provenance.notes ?? []), ...loadNotes];
        notes.push(headerDate ? `File header observation time: ${headerDate}` : 'File header has no DATE-OBS/MJD-OBS; date shown is from the archive plane table.');
        if (image.wcs?.hasSip) notes.push('Header declares SIP distortion; this viewer uses a plain TAN WCS, so sky positions may be off by a fraction of a pixel to a few pixels towards the edges.');
        const done: EpochEntry = { ...ep, status: 'ready', image, provenance: { ...ep.provenance, notes } };
        updateEpoch(ep.id, { status: 'ready', image, provenance: done.provenance });
        return done;
      } catch (e) {
        updateEpoch(ep.id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        inflight.current.delete(ep.id);
      }
    })();
    inflight.current.set(ep.id, p);
    return p;
  }, [updateEpoch]);

  const resetAnalysis = (): Partial<State> => (ref.current.dataset?.cube?.lazy?.dispose(), cubeSession.current?.reset(), {
    detection: {}, selectedCandidate: null, detectError: null, playing: false, bandFilter: 'all', allSky: IDLE_ALLSKY,
    cubeTick: 0, loadingChannels: [], channelError: null, bulk: null,
    catalogs: { 'gaia-dr3': emptyLayer(), allwise: emptyLayer() },
  });

  const selectTarget = useCallback((pos: SkyPosition, name?: string, challenge: ChallengeTarget | null = null) => {
    const cur = ref.current.target;
    if (cur && cur.pos.ra === pos.ra && cur.pos.dec === pos.dec && cur.challenge?.id === challenge?.id) return;
    ++searchToken.current; // a discovery still running for the previous target must not overwrite this one
    dispatch({ ...resetAnalysis(), target: makeTarget(pos, name, challenge), phase: 'idle', message: null, dataset: null, epochIndex: 0, compareIndex: 1, tab: 'image' });
  }, []);

  const search = useCallback(async (pos: SkyPosition, name?: string, challenge: ChallengeTarget | null = null) => {
    const token = ++searchToken.current;
    const target = makeTarget(pos, name, challenge);
    const searchPos = target.searchPos;
    dispatch({ ...resetAnalysis(), target, phase: 'searching', message: 'Looking up SPHEREx exposures covering this position (IRSA SIA2 / TAP are optional discovery services; pixels are read from AWS)…', dataset: null, epochIndex: 0, compareIndex: 1, tab: 'image' });
    try {
      const { epochs, attempts } = await discoverEpochs(searchPos);
      if (token !== searchToken.current) return;
      const failed = attempts.filter((a) => !a.ok);
      const allFailed = attempts.length > 0 && failed.length === attempts.length;
      // Discovery being unavailable must not block the app: the All-Sky Cube needs only AWS.
      const note = epochs.length > 0
        ? `${epochs.length} individual SPHEREx exposures (spectral images) cover this position. Each exposure is one detector sampling a limited wavelength range — these are observation epochs, not spectral channels.${failed.length ? ` (Discovery partly unavailable: ${failed.map((a) => a.provider).join(', ')}.)` : ''}`
        : allFailed
          ? `Level-2 exposure discovery is unavailable right now (${failed.map((a) => `${a.provider}: ${a.error}`).join(' | ')}). AWS S3 data do not depend on it: the DR1 All-Sky Cube tile for this position can still be loaded from the Spectral tab.`
          : 'No SPHEREx spectral images covering this position were reported (yet). The DR1 All-Sky Cube (Spectral tab) is independent of this and may still cover the position.';
      const dataset: Dataset = { origin: 'spherex-live', title: target.name, epochs, cube: null, structureNote: note };
      dispatch({ dataset, phase: 'ready', message: null });
      if (epochs.length > 0) void ensureEpoch(0); else dispatch({ tab: 'spectral' });
    } catch (e) {
      if (token !== searchToken.current) return;
      dispatch({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [ensureEpoch]);

  const startDemo = useCallback(() => {
    const cur = ref.current.target;
    const pos = cur?.pos ?? { ra: 133.795129, dec: -7.245147 };
    const name = cur?.name ?? 'WISE 0855−0714 (field centre)';
    const dataset = makeDemoDataset(pos, name);
    dispatch({
      ...resetAnalysis(),
      target: cur ?? { name, pos, searchPos: pos, challenge: null, propagated: false },
      dataset, phase: 'ready', message: null, epochIndex: 0, compareIndex: 1, channel: 0, tab: 'image',
    });
  }, []);

  const loadFile = useCallback(async (file: File) => {
    dispatch({ ...resetAnalysis(), phase: 'searching', message: `Reading ${file.name}…` });
    try {
      const parsed = parseFits(await file.arrayBuffer());
      const hdu = pickScienceHdu(parsed);
      if (!hdu) throw new Error('No image extension found in this FITS file.');
      const isCube = hdu.naxis.length >= 3 && hdu.naxis[2] > 1;
      let cube = isCube ? toSpectralCube(parsed, hdu) : null;
      let cubeInfo: CubeInfo | null = null;
      const tabHdu = findHdu(parsed, 'SPECTRAL_CHANNELS');
      if (isCube && tabHdu && isAllSkyImageHdu(hdu)) {
        try {
          const built = buildAllSkyCube({ file: parsed, hdu }, { file: parsed, hdu: tabHdu }, parsed.hdus.map((h) => h.header));
          const tileNo = /Npix(\d+)_cube/i.exec(file.name)?.[1];
          cube = built.cube;
          cubeInfo = { kind: 'allsky-dr1', product: `SPHEREx DR1 All-Sky Cube tile${tileNo ? ` Npix${tileNo}` : ''} (from your file)`, tile: tileNo ? Number(tileNo) : null, url: null, resolvedVia: 'local-file', transport: 'local', bytesRead: null, notes: built.notes };
        } catch { /* fall back to the generic cube below */ }
      }
      const image = toFitsImage(parsed, hdu);
      const obs = headerObservationTime(hdu.header);
      const pos: SkyPosition = image.wcs ? { ra: image.wcs.crval[0], dec: image.wcs.crval[1] } : { ra: 0, dec: 0 };
      const epochs: EpochEntry[] = isCube ? [] : [{
        id: `file-${file.name}`, label: file.name, mjd: null, isoDate: obs, detector: null, wavelengthRangeUm: null,
        status: 'ready', image,
        provenance: {
          origin: 'user-file', mission: String(hdu.header['TELESCOP']?.value ?? 'unknown'), instrument: String(hdu.header['INSTRUME']?.value ?? 'unknown'),
          product: `User-supplied FITS (${hdu.extname})`, observationDate: obs, mjd: null,
          notes: [obs ? 'Observation time from DATE-OBS/MJD-OBS in the file header.' : 'No DATE-OBS/MJD-OBS in the header: observation date unknown.'],
        },
      }];
      const dataset: Dataset = {
        origin: 'user-file', title: file.name, epochs, cube, cubeInfo,
        structureNote: isCube
          ? cubeInfo
            ? `SPHEREx DR1 All-Sky Cube tile with ${cube?.depth} channels read from your file. Wavelengths come from its SPECTRAL_CHANNELS table.`
            : `Cube with ${cube?.depth} planes read from the file. It was not recognised as a SPHEREx All-Sky Cube (expected an IMAGE extension with ${102} planes plus a SPECTRAL_CHANNELS table), so its planes are generic and are not verified spectral channels. Wavelengths are shown only if the header carries a linear WAVE axis.`
          : 'Single 2-D image from your file: one observation, no temporal series.',
      };
      dispatch({
        dataset, phase: 'ready', message: null, epochIndex: 0, compareIndex: 1, channel: 0, tab: isCube ? 'spectral' : 'image',
        target: { name: file.name, pos, searchPos: pos, challenge: null, propagated: false },
      });
    } catch (e) {
      dispatch({ phase: 'error', message: `Could not read FITS file: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  const cancelAllSkyCube = useCallback(() => { cubeSession.current?.cancel(); }, []);
  const authorizeAllSkyDownload = useCallback(() => { cubeSession.current?.authorize(); }, []);

  const loadAllSkyCube = useCallback(async () => {
    const s0 = ref.current;
    const t0 = s0.target;
    const session = cubeSession.current!;
    if (['discovering', 'downloading', 'validating'].includes(s0.allSky.status)) return;
    if (!t0 || !s0.dataset || s0.dataset.origin !== 'spherex-live') {
      dispatch({ allSky: { ...IDLE_ALLSKY, status: 'error', message: 'The All-Sky Cube is real archive data: choose a sky position first (it is not available for the synthetic demo or opened files).' } });
      return;
    }
    const unsubscribe = session.subscribe((st) => { if (ref.current.target === t0) dispatch({ allSky: allSkyFromSession(st) }); });
    try {
      const res = await session.start(t0.searchPos, { autoAuthorize: true });
      if (!res || ref.current.target !== t0) return; // cancelled / failed (state already published) / target changed
      const first = res.cube.blankChannels?.includes(0) ? Math.max(0, [...Array(res.cube.depth).keys()].find((k) => !res.cube.blankChannels?.includes(k)) ?? 0) : 0;
      dispatch((st) => (st.target === t0 && st.dataset
        ? { dataset: { ...st.dataset, cube: res.cube, cubeInfo: res.info }, allSky: IDLE_ALLSKY, channel: first, tab: 'spectral' as StageTab }
        : {}));
    } finally {
      unsubscribe();
    }
  }, []);

  const selectEpoch = useCallback((i: number) => { dispatch({ epochIndex: i, selectedCandidate: null }); void ensureEpoch(i); }, [ensureEpoch]);
  const selectCompare = useCallback((i: number) => { dispatch({ compareIndex: i }); void ensureEpoch(i); }, [ensureEpoch]);
  const setChannel = useCallback((c: number) => dispatch({ channel: c }), []);

  const ensureChannel = useCallback(async (c: number) => {
    const t0 = ref.current.target;
    const cube = ref.current.dataset?.cube;
    const lazy = cube?.lazy;
    if (!cube || !lazy) return;
    const wanted = [c, c - 1, c + 1].filter((k) => k >= 0 && k < cube.depth && !cube.blankChannels?.includes(k) && !lazy.isLoaded(k));
    if (wanted.length === 0) return;
    const alive = () => ref.current.target === t0 && ref.current.dataset?.cube === cube;
    dispatch((st) => ({ loadingChannels: [...new Set([...st.loadingChannels, ...wanted])], channelError: st.channelError?.channel === c ? null : st.channelError }));
    await Promise.all(wanted.map(async (k) => {
      try {
        await lazy.load(k);
      } catch (e) {
        if (e instanceof CancelledError || !alive()) return;
        if (k === c) dispatch({ channelError: { channel: c, message: e instanceof Error ? e.message : String(e) } });
      } finally {
        if (alive()) dispatch((st) => ({ loadingChannels: st.loadingChannels.filter((x) => x !== k), cubeTick: st.cubeTick + 1 }));
      }
    }));
  }, []);

  const loadAllChannels = useCallback(async () => {
    const t0 = ref.current.target;
    const cube = ref.current.dataset?.cube;
    const lazy = cube?.lazy;
    if (!cube || !lazy || ref.current.bulk) return;
    const todo = [...Array(cube.depth).keys()].filter((k) => !cube.blankChannels?.includes(k) && !lazy.isLoaded(k));
    if (todo.length === 0) return;
    const alive = () => ref.current.target === t0 && ref.current.dataset?.cube === cube;
    let done = 0;
    let failed: string | null = null;
    dispatch({ bulk: { done: 0, total: todo.length }, channelError: null });
    const queue = [...todo];
    const worker = async () => {
      while (queue.length && alive() && !failed) {
        const k = queue.shift()!;
        try { await lazy.load(k); } catch (e) { if (!(e instanceof CancelledError)) failed = e instanceof Error ? e.message : String(e); }
        done++;
        if (alive()) dispatch((st) => ({ bulk: { done, total: todo.length }, cubeTick: st.cubeTick + 1 }));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (alive()) dispatch({ bulk: null, channelError: failed ? { channel: ref.current.channel, message: `Loading all channels stopped: ${failed}` } : null });
  }, []);

  const toggleCatalog = useCallback((id: CatalogId) => {
    const s = ref.current;
    const layer = s.catalogs[id];
    const enabled = !layer.enabled;
    const setLayer = (l: Partial<CatalogLayer>) => dispatch((st) => ({ catalogs: { ...st.catalogs, [id]: { ...st.catalogs[id], ...l } } }));
    setLayer({ enabled });
    if (!enabled || layer.status === 'ready' || layer.status === 'loading' || !s.target) return;
    if (s.dataset?.origin === 'demo') {
      setLayer({ status: 'error', error: 'Catalog overlays are disabled for synthetic demo data: real catalog sources would not correspond to it.' });
      return;
    }
    setLayer({ status: 'loading', error: undefined });
    CATALOG_SERVICES[id]
      .search({ center: s.target.searchPos, radiusDeg: 0.09, limit: 400 })
      .then((sources) => setLayer({ status: 'ready', sources }))
      .catch((e: unknown) => setLayer({ status: 'error', error: e instanceof Error ? e.message : String(e) }));
  }, []);

  const runDetection = useCallback(async (epochIndex: number) => {
    const ep = await ensureEpoch(epochIndex);
    if (!ep?.image) { dispatch({ detectError: 'This epoch has no loaded image to analyse.' }); return; }
    dispatch({ detectBusy: true, detectError: null });
    try {
      const res = await analysis.detect(ep.image, ref.current.detectOpts);
      dispatch((s) => ({
        detection: { ...s.detection, [ep.id]: res }, detectBusy: false, selectedCandidate: null,
        lastDiscovery: res.candidates.length > 0 ? Date.now() : s.lastDiscovery,
      }));
    } catch (e) {
      dispatch({ detectBusy: false, detectError: e instanceof Error ? e.message : String(e) });
    }
  }, [ensureEpoch]);

  const visibleIndices = useCallback(() => visibleIndicesOf(ref.current), []);

  const actions = useMemo<Actions>(() => ({
    selectTarget, search, startDemo, loadFile, loadAllSkyCube, authorizeAllSkyDownload, cancelAllSkyCube, selectEpoch, selectCompare, ensureEpoch, setChannel, ensureChannel, loadAllChannels, patch, toggleCatalog, runDetection, visibleIndices,
  }), [selectTarget, search, startDemo, loadFile, loadAllSkyCube, authorizeAllSkyDownload, cancelAllSkyCube, selectEpoch, selectCompare, ensureEpoch, setChannel, ensureChannel, loadAllChannels, patch, toggleCatalog, runDetection, visibleIndices]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
