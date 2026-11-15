/**
 * Aladin Lite v3 loader. Loaded from the CDS CDN at runtime (a plain <script>), typed minimally here.
 * Aladin shows *context* surveys (DSS2, 2MASS, AllWISE …). These are NOT SPHEREx observations.
 */
export interface AladinSource {
  ra: number;
  dec: number;
}
export interface AladinCatalog {
  addSources(src: AladinSource | AladinSource[]): void;
  removeAll(): void;
}
export interface AladinOverlay {
  add(item: unknown): void;
  removeAll(): void;
  show?(): void;
  hide?(): void;
}
export interface AladinView {
  gotoRaDec(ra: number, dec: number): void;
  setFoV(deg: number): void;
  setBaseImageLayer(layer: unknown): void;
  getRaDec(): [number, number];
  addCatalog(cat: AladinCatalog): void;
  addOverlay?(overlay: AladinOverlay): void;
  /** [horizontal, vertical] field of view in degrees; setFoV() sets the horizontal one. */
  getFov?(): [number, number];
  removeLayers(): void;
  showCooGrid?(show: boolean): void;
  setProjection?(p: string): void;
  /** Screen position (px, relative to the view) of a sky position; null/undefined when not visible. */
  world2pix?(ra: number, dec: number): [number, number] | null | undefined;
  pix2world?(x: number, y: number): [number, number] | null | undefined;
  /** Smooth pan (duration in seconds). */
  animateToRaDec?(ra: number, dec: number, durationSec?: number): void;
  /** Smooth zoom (duration in seconds). */
  zoomToFoV?(fovDeg: number, durationSec?: number): void;
  on?(event: string, cb: (...args: unknown[]) => void): void;
}
export interface AladinStatic {
  init: Promise<void>;
  /** v3 factory for a HiPS layer from a base URL or CDS ID. Optional: older builds accept the URL string directly. */
  HiPS?(urlOrId: string, options?: Record<string, unknown>): unknown;
  aladin(el: HTMLElement, opts: Record<string, unknown>): AladinView;
  catalog(opts: Record<string, unknown>): AladinCatalog;
  source(ra: number, dec: number, data?: Record<string, unknown>): AladinSource;
  graphicOverlay?(opts?: Record<string, unknown>): AladinOverlay;
  polygon?(coords: number[][], opts?: Record<string, unknown>): unknown;
}

declare global {
  interface Window {
    A?: AladinStatic;
  }
}

export const ALADIN_SCRIPT = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js';
/**
 * Tried in order. The CDS build is a classic script that sets `window.A`. The npm build on jsDelivr is an ES module
 * that exports `A` (README: `import A from 'aladin-lite'`), so it must be loaded with `import()`.
 */
export const ALADIN_SOURCES: readonly { url: string; kind: 'script' | 'module' }[] = [
  { url: ALADIN_SCRIPT, kind: 'script' },
  { url: 'https://cdn.jsdelivr.net/npm/aladin-lite@3.9.0-beta/dist/aladin.js', kind: 'module' },
];

export const CONTEXT_SURVEYS = [
  { id: 'P/DSS2/color', label: 'DSS2 colour (optical)' },
  { id: 'P/2MASS/color', label: '2MASS (near-IR)' },
  { id: 'P/allWISE/color', label: 'AllWISE (mid-IR)' },
] as const;

let loading: Promise<AladinStatic> | null = null;

async function importModule(src: string): Promise<AladinStatic> {
  try {
    const mod = (await import(/* @vite-ignore */ src)) as { default?: AladinStatic; A?: AladinStatic };
    const A = mod.default ?? mod.A ?? window.A;
    if (!A || !A.init) throw new Error('module has no Aladin export');
    window.A = A;
    await A.init;
    return A;
  } catch (e) {
    throw new Error(`${src} (${e instanceof Error ? e.message : String(e)})`);
  }
}

function injectScript(src: string): Promise<AladinStatic> {
  return new Promise<AladinStatic>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => {
      const A = window.A;
      if (!A) return reject(new Error(`${src} loaded but window.A is missing`));
      A.init.then(() => resolve(A), reject);
    };
    s.onerror = () => {
      s.remove();
      reject(new Error(src));
    };
    document.head.appendChild(s);
  });
}

export function loadAladin(): Promise<AladinStatic> {
  if (window.A) return window.A.init.then(() => window.A as AladinStatic);
  if (loading) return loading;
  loading = (async () => {
    const failed: string[] = [];
    for (const { url, kind } of ALADIN_SOURCES) {
      try {
        return await (kind === 'module' ? importModule(url) : injectScript(url));
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e));
      }
    }
    loading = null;
    throw new Error(
      `Could not load Aladin Lite. Blocked or unreachable: ${failed.join(' , ')}. Check your connection, firewall or ad blocker (browser dev tools > Network).`,
    );
  })();
  return loading;
}

/**
 * Background (context) HiPS providers per survey chip, tried in order.
 *
 * Why not Aladin's default CDS IDs ("P/DSS2/color"): Aladin resolves an ID through the CDS MocServer
 * (alasky.unistra.fr) and retries forever when that host is unreachable. A full HiPS base URL skips that lookup.
 *
 * Sources (checked 2026-11-14): ESA's official list https://skies.esac.esa.int/hipslist gives the ESA URLs below for
 * ivo://CDS/P/DSS2/color, ivo://CDS/P/2MASS/color and ivo://CDS/P/allWISE/color; ESA's DSSColor `properties` file was read
 * (hips_frame=equatorial, hips_order=9, hips_tile_format=jpeg). The IRSA mirrors and the CDS URL are listed by their own
 * HiPS landing pages. Browser access / CORS cannot be known statically, so every provider is verified at runtime
 * (`verifyHips`) before Aladin is pointed at it. These are third-party context images — never SPHEREx data.
 */
export interface HipsProvider {
  label: string;
  url: string;
  note?: string;
}
export const SURVEY_PROVIDERS: Readonly<Record<string, readonly HipsProvider[]>> = {
  'P/DSS2/color': [
    { label: 'DSS2 colour · ESA Sky', url: 'https://skies.esac.esa.int/DSSColor' },
    { label: 'DSS2 colour · ESA Sky CDN', url: 'https://cdn.skies.esac.esa.int/DSSColor' },
    { label: 'DSS2 colour · CDS', url: 'https://alasky.cds.unistra.fr/DSS/DSSColor' },
    { label: 'DSS2 colour · CDS (u-strasbg)', url: 'https://alasky.u-strasbg.fr/DSS/DSSColor' },
    { label: 'DSS2 colour · CDS mirror', url: 'https://alaskybis.cds.unistra.fr/DSS/DSSColor' },
    { label: 'DSS2 colour · NASA/IPAC IRSA', url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color' },
  ],
  'P/2MASS/color': [
    { label: '2MASS colour · ESA Sky', url: 'https://skies.esac.esa.int/2MASSColor' },
    { label: '2MASS colour · NASA/IPAC IRSA', url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color' },
    { label: '2MASS colour · CDS', url: 'https://alasky.cds.unistra.fr/2MASS/Color' },
    { label: '2MASS colour · CDS (u-strasbg)', url: 'https://alasky.u-strasbg.fr/2MASS/Color' },
  ],
  'P/allWISE/color': [
    { label: 'AllWISE colour · ESA Sky', url: 'https://skies.esac.esa.int/AllWISEColor' },
    {
      label: 'AllWISE RGB (W4,W2,W1) · NASA/IPAC IRSA',
      url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1',
      note: 'Different band composite than CDS allWISE/color.',
    },
  ],
};

export interface HipsInfo {
  order: number;
  frame: string;
  tileFormat: string;
  title: string | null;
}

/** Parse a HiPS `properties` file (`key = value` lines). Throws unless it describes a usable HiPS. */
export function parseHipsProperties(text: string): HipsInfo {
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) kv.set(m[1], m[2]);
  }
  const order = Number(kv.get('hips_order'));
  const tileFormat = kv.get('hips_tile_format');
  if (!Number.isFinite(order) || !tileFormat) throw new Error('not a HiPS properties file (no hips_order / hips_tile_format)');
  if (kv.get('hips_status')?.toLowerCase().includes('private')) throw new Error('HiPS is marked private');
  const frame = (kv.get('hips_frame') ?? 'equatorial').toLowerCase();
  if (frame !== 'equatorial' && frame !== 'icrs' && frame !== 'galactic') throw new Error(`unsupported hips_frame "${frame}"`);
  return { order, frame, tileFormat, title: kv.get('obs_title') ?? null };
}

const verified = new Map<string, Promise<HipsInfo>>();

/**
 * Fetch `<base>/properties` the same way Aladin does (browser fetch, CORS enforced) and validate it. Results — successes
 * AND failures — are cached for the page lifetime, so an unavailable provider is probed once, never in a loop.
 */
export function verifyHips(baseUrl: string, timeoutMs = 8000): Promise<HipsInfo> {
  const cached = verified.get(baseUrl);
  if (cached) return cached;
  const p = (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/properties`, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseHipsProperties(await res.text());
    } catch (e) {
      if (ctl.signal.aborted) throw new Error(`timed out after ${timeoutMs / 1000}s`);
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(t);
    }
  })();
  verified.set(baseUrl, p);
  return p;
}

export interface ResolvedSurvey {
  provider: HipsProvider;
  info: HipsInfo;
}

/** All providers of one survey are asked at once; the first (in list order of preference) that verifies wins. */
async function firstWorking(providers: readonly HipsProvider[], failures: string[]): Promise<ResolvedSurvey | null> {
  const results = await Promise.all(providers.map((provider) =>
    verifyHips(provider.url, 12000).then(
      (info) => ({ provider, info }),
      (e) => { failures.push(`${new URL(provider.url).host} (${e instanceof Error ? e.message : String(e)})`); return null; },
    )));
  return results.find((r): r is ResolvedSurvey => r !== null) ?? null;
}

/**
 * A verified provider for the requested survey. If every mirror of that survey is unreachable from this network, any
 * other context survey that IS reachable is used instead (its real name is shown in the credit line), so the sky map
 * does not go dark just because one host is down. Throws only when nothing at all can be reached.
 */
export async function resolveSurvey(surveyId: string): Promise<ResolvedSurvey> {
  const failures: string[] = [];
  const own = await firstWorking(SURVEY_PROVIDERS[surveyId] ?? [], failures);
  if (own) return own;
  for (const other of Object.keys(SURVEY_PROVIDERS)) {
    if (other === surveyId) continue;
    const alt = await firstWorking(SURVEY_PROVIDERS[other], failures);
    if (alt) return { provider: { ...alt.provider, label: `${alt.provider.label} (fallback)` }, info: alt.info };
  }
  throw new Error(`None of the background-survey providers could be reached from this network: ${[...new Set(failures)].join('; ')}.`);
}

/** Point an existing Aladin view at a verified HiPS base URL (Aladin Lite v3: `setBaseImageLayer`). */
export function applyBaseSurvey(A: AladinStatic, view: AladinView, provider: HipsProvider): void {
  let layer: unknown = provider.url;
  try {
    if (typeof A.HiPS === 'function') layer = A.HiPS(provider.url, { name: provider.label });
  } catch {
    layer = provider.url; // a base URL string is accepted by setBaseImageLayer as well
  }
  view.setBaseImageLayer(layer);
}
