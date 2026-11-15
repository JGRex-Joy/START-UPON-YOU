/**
 * Does the DR1 All-Sky Cube tile for a sky position exist in the public bucket? One anonymous HEAD (and, only if the
 * documented path misses, a bucket listing) through the existing AWS provider code. No IRSA involved.
 */
import { resolveCubeKey } from './allSkyProvider';
import { AwsError } from './errors';

export type TileAvailability =
  | { status: 'found'; key: string; size: number | null; lastModified: string | null; how: 'documented-path' | 'listing' }
  | { status: 'absent'; message: string }
  | { status: 'error'; message: string; retryable: boolean };

const settled = new Map<number, TileAvailability>();

/** Definitive answers (found / absent) are remembered for the page lifetime; errors never are, so retry always asks again. */
export async function checkTileAvailability(npix: number, signal?: AbortSignal): Promise<TileAvailability> {
  const memo = settled.get(npix);
  if (memo) return memo;
  try {
    const r = await resolveCubeKey(npix, signal);
    const out: TileAvailability = { status: 'found', key: r.key, size: r.size, lastModified: r.lastModified, how: r.how };
    settled.set(npix, out);
    return out;
  } catch (e) {
    if (e instanceof AwsError && (e.code === 'not_found' || e.code === 'unpublished')) {
      const out: TileAvailability = { status: 'absent', message: e.message };
      settled.set(npix, out);
      return out;
    }
    if (signal?.aborted) throw e;
    return { status: 'error', message: e instanceof Error ? e.message : String(e), retryable: !(e instanceof AwsError) || e.transient };
  }
}

export function clearTileAvailabilityMemo(): void { settled.clear(); }
