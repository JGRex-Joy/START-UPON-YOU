/**
 * Local cache of downloaded All-Sky Cube tiles (IMAGE layer + channel table + parsed headers).
 * A tile's IMAGE layer is ~107 MB: re-downloading it per visit is slow and impossible when AWS is unreachable.
 * Entries live in the browser Cache API (disk-backed, not in the JS heap) with a small LRU limit so an 8 GB laptop is
 * not filled up. Best-effort: failures never break loading. (The Cache API cannot store 206 responses, so the
 * assembled bytes are stored under synthetic URLs.)
 */
import type { FitsHeader } from '../../types';
import type { FitsHdu } from '../fits/parser';

export interface CachedCubeMeta {
  id: string;
  tile: number;
  key: string | null;
  url: string;
  via: 'aws-s3' | 'sia2' | 'direct-url' | 'local-file';
  etag: string | null;
  lastModified: string | null;
  fileBytes: number | null;
  storedAt: number;
  imageHdu: FitsHdu;
  tableHdu: FitsHdu | null;
  headers: FitsHeader[];
  notes: string[];
}
export interface CachedCube { meta: CachedCubeMeta; image: Uint8Array; table: Uint8Array | null }

export interface CubeCache {
  get(id: string): Promise<CachedCube | null>;
  /** false if it could not be stored (quota, private mode…). Never throws. */
  put(entry: CachedCube): Promise<boolean>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const DEFAULT_MAX_CACHED_TILES = 2;

/** In-memory cache for tests / explicit opt-in (it would pin ~107 MB per tile in the heap, so not the browser default). */
export class MemoryCubeCache implements CubeCache {
  private map = new Map<string, CachedCube>();
  constructor(private maxEntries = DEFAULT_MAX_CACHED_TILES) {}
  async get(id: string): Promise<CachedCube | null> { return this.map.get(id) ?? null; }
  async put(entry: CachedCube): Promise<boolean> {
    this.map.set(entry.meta.id, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = [...this.map.values()].sort((a, b) => a.meta.storedAt - b.meta.storedAt)[0];
      this.map.delete(oldest.meta.id);
    }
    return true;
  }
  async delete(id: string): Promise<void> { this.map.delete(id); }
  async clear(): Promise<void> { this.map.clear(); }
  get size(): number { return this.map.size; }
}

const CACHE_NAME = 'stars-upon-you-spherex-v1';
const ORIGIN = 'https://cache.stars-upon-you.invalid';

export class BrowserCubeCache implements CubeCache {
  constructor(private maxEntries = DEFAULT_MAX_CACHED_TILES) {}
  private url(id: string, part: 'meta' | 'image' | 'table'): string { return `${ORIGIN}/${encodeURIComponent(id)}/${part}`; }
  private open(): Promise<Cache> { return caches.open(CACHE_NAME); }

  async get(id: string): Promise<CachedCube | null> {
    try {
      const c = await this.open();
      const m = await c.match(this.url(id, 'meta'));
      if (!m) return null;
      const meta = (await m.json()) as CachedCubeMeta;
      const img = await c.match(this.url(id, 'image'));
      if (!img) return null;
      const image = new Uint8Array(await img.arrayBuffer());
      if (image.length !== meta.imageHdu.dataBytes) { await this.delete(id); return null; } // damaged entry
      let table: Uint8Array | null = null;
      if (meta.tableHdu) {
        const t = await c.match(this.url(id, 'table'));
        if (!t) return null;
        table = new Uint8Array(await t.arrayBuffer());
      }
      return { meta, image, table };
    } catch { return null; }
  }

  async put(entry: CachedCube): Promise<boolean> {
    const id = entry.meta.id;
    try {
      const c = await this.open();
      // meta is written LAST: its presence marks a complete entry.
      await c.put(this.url(id, 'image'), new Response(entry.image));
      if (entry.table) await c.put(this.url(id, 'table'), new Response(entry.table));
      await c.put(this.url(id, 'meta'), new Response(JSON.stringify(entry.meta), { headers: { 'content-type': 'application/json' } }));
      await this.evict(c);
      return true;
    } catch {
      await this.delete(id);
      return false;
    }
  }

  private async evict(c: Cache): Promise<void> {
    const metas: CachedCubeMeta[] = [];
    for (const req of await c.keys()) {
      if (!req.url.endsWith('/meta')) continue;
      try { metas.push((await (await c.match(req))!.json()) as CachedCubeMeta); } catch { await c.delete(req); }
    }
    metas.sort((a, b) => b.storedAt - a.storedAt);
    for (const old of metas.slice(this.maxEntries)) await this.delete(old.id);
  }

  async delete(id: string): Promise<void> {
    try { const c = await this.open(); await Promise.all((['meta', 'image', 'table'] as const).map((p) => c.delete(this.url(id, p)))); } catch { /* ignore */ }
  }
  async clear(): Promise<void> { try { await caches.delete(CACHE_NAME); } catch { /* ignore */ } }
}

export function defaultCubeCache(): CubeCache | null {
  return typeof caches !== 'undefined' ? new BrowserCubeCache() : null;
}
