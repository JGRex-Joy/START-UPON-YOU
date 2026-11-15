/**
 * Provider abstraction of the SPHEREx Data Service.
 *   UI → loadAllSkyCubeTile / loadEpochImage → provider (AWS S3 primary, IRSA optional) → bytes → existing FITS parsers
 * A provider only answers "where is this product and how do I fetch byte ranges of it". It never parses science data.
 */
import type { CubeInfo, SkyPosition } from '../../types';
import type { RangeFetcher } from '../fits/remote';

export interface CubeLocation {
  url: string;
  key: string | null;
  via: CubeInfo['resolvedVia'];
  notes: string[];
  objectSize: number | null;
  etag: string | null;
  lastModified: string | null;
  fetcher: RangeFetcher;
}

export interface LocateContext { signal?: AbortSignal; isCancelled: () => boolean }

export interface AllSkyProvider {
  readonly id: 'aws-s3' | 'irsa';
  readonly label: string;
  /** Network-free identifier of the tile in this provider's namespace (local cache key). null = not cacheable. */
  candidateId(npix: number): string | null;
  locate(pos: SkyPosition, npix: number, ctx: LocateContext): Promise<CubeLocation>;
}
