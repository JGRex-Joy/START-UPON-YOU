/** Shared domain types. Missing data is always `NaN` in pixel arrays — never 0. */

export type HeaderValue = string | number | boolean | null;
export interface HeaderCard {
  value: HeaderValue;
  comment?: string;
}
export type FitsHeader = Record<string, HeaderCard>;

/** Celestial TAN (gnomonic) WCS. SIP distortion terms are NOT applied (see `hasSip`). */
export interface Wcs {
  crpix: [number, number];
  crval: [number, number];
  /** Pixel -> intermediate world coordinates (degrees). */
  cd: [[number, number], [number, number]];
  ctype: [string, string];
  /** True when the header declares SIP distortion that this implementation ignores. */
  hasSip: boolean;
}

export interface FitsImage {
  width: number;
  height: number;
  /** Row-major, y = 0 is the bottom row (FITS convention). NaN marks missing/invalid pixels. */
  data: Float32Array;
  header: FitsHeader;
  wcs: Wcs | null;
  extname: string;
  bunit: string | null;
}

export interface SpectralCube {
  width: number;
  height: number;
  depth: number;
  /** One Float32Array (width*height) per spectral channel/slice. Lazily filled. */
  slices: (Float32Array | null)[];
  header: FitsHeader;
  wcs: Wcs | null;
  /** Wavelength in micron per slice — only when the header really states it. */
  wavelengthsUm: (number | null)[] | null;
  bunit: string | null;
  readSlice: (index: number) => Float32Array;
  /** 0-based channels that hold no data (e.g. All-Sky Cube channels 51 and 52). Never plotted as zero flux. */
  blankChannels?: number[];
  /** [lower, upper] channel edges in micron, when the product's channel table states them. */
  wavelengthEdgesUm?: ([number, number] | null)[] | null;
  /**
   * Present when channels are fetched on demand (HTTP Range). `readSlice(i)` then returns the loaded plane, or an
   * all-NaN placeholder while channel `i` is not loaded: always check `isLoaded` / await `load` first.
   */
  lazy?: {
    bytesPerChannel: number;
    isLoaded(index: number): boolean;
    loadedCount(): number;
    load(index: number): Promise<void>;
    /** Stop in-flight and future reads (call when the cube is discarded). */
    dispose(): void;
  };
}

/** Where a spectral cube came from and what was (not) verified. Level-2 exposures are never described this way. */
export interface CubeInfo {
  kind: 'allsky-dr1';
  product: string;
  /** HEALPix order-5 NESTED tile index, when known. */
  tile: number | null;
  url: string | null;
  /** How the product location was established. 'aws-s3' = verified directly in the public bucket (no IRSA API involved). */
  resolvedVia: 'aws-s3' | 'sia2' | 'direct-url' | 'local-file';
  /** S3 key when the product lives in S3. */
  key?: string | null;
  /** true when channels are loaded on demand instead of the whole IMAGE layer up front. */
  lazy?: boolean;
  transport: 'range' | 'stream' | 'local' | 'cache';
  bytesRead: number | null;
  notes: string[];
}

export type DataOrigin = 'spherex-live' | 'user-file' | 'demo';

export interface Provenance {
  origin: DataOrigin;
  mission: string;
  instrument: string;
  product: string;
  /** Verbatim or derived from archive metadata. null = not available. */
  observationDate: string | null;
  mjd: number | null;
  url?: string;
  /** Key of the Level-2 file in the public AWS bucket, when known. AWS is tried first for the pixels. */
  s3Key?: string;
  notes?: string[];
}

export type EpochStatus = 'idle' | 'loading' | 'ready' | 'error';

/** One individual observation (exposure/plane) — a *temporal* epoch. */
export interface EpochEntry {
  id: string;
  label: string;
  mjd: number | null;
  isoDate: string | null;
  detector: string | null;
  /** Wavelength range sampled in this exposure at the target, if the archive reports it. */
  wavelengthRangeUm: [number, number] | null;
  provenance: Provenance;
  status: EpochStatus;
  error?: string;
  image?: FitsImage;
}

export interface Dataset {
  origin: DataOrigin;
  title: string;
  epochs: EpochEntry[];
  cube: SpectralCube | null;
  /** Provenance of `cube` when it is a real archive product (absent for demo / generic user cubes). */
  cubeInfo?: CubeInfo | null;
  /** Human readable explanation of the data structure shown in the UI. */
  structureNote: string;
}

export interface SkyPosition {
  ra: number;
  dec: number;
}

export interface Candidate {
  id: number;
  x: number;
  y: number;
  peak: number;
  flux: number;
  area: number;
  /** Peak above background in units of sigma. */
  snr: number;
  /** Heuristic 0..1 derived from SNR and size; NOT a statistical probability. */
  score: number;
  sky: SkyPosition | null;
}

export interface DetectionResult {
  candidates: Candidate[];
  background: number;
  sigma: number;
  threshold: number;
  k: number;
  minPixels: number;
  validPixels: number;
}

export interface DifferenceResult {
  width: number;
  height: number;
  data: Float32Array;
  sigma: number;
  shift: [number, number];
  scale: number;
  notes: string[];
  /** Always false in this prototype — no photometric/PSF calibration is performed. */
  calibrated: false;
}

export interface TrackMatch {
  from: Candidate;
  to: Candidate | null;
  displacementArcsec: number | null;
  displacementPx: number | null;
  fluxRatio: number | null;
  kind: 'stable' | 'potential-mover' | 'potential-variable' | 'unmatched';
}

export type CatalogId = 'gaia-dr3' | 'allwise';

export interface CatalogSource {
  id: string;
  catalog: CatalogId;
  ra: number;
  dec: number;
  /** Catalog reference epoch (decimal year) for ra/dec. */
  epoch: number;
  pmRa: number | null;
  pmDec: number | null;
  magnitudes: Record<string, number | null>;
  label: string;
  extra: Record<string, string | number | null>;
}

export interface ChallengeTarget {
  id: string;
  name: string;
  ra: number;
  dec: number;
  raSexagesimal: string;
  decSexagesimal: string;
  /** Proper motion in mas/yr (RA*cos(dec), Dec) at J2000 when known. */
  pmRa: number | null;
  pmDec: number | null;
  kind: string;
  /** Scientific focus of the challenge: positional change (proper motion) or brightness change over time. */
  focus: 'motion' | 'variability';
  note: string;
  source: { label: string; url: string };
  /** Positional precision of the stored coordinates. */
  precision: string;
}
