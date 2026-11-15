/**
 * Reading FITS files over HTTP without downloading them whole.
 *
 * FITS files are sequences of 2880-byte blocks: a header (ends at its END card) followed by data padded to a block
 * boundary. The data size is derived from the header (BITPIX, NAXISn, PCOUNT, GCOUNT), so the start of every HDU is
 * found by hopping header to header — no HDU order or offset is assumed.
 *
 * Two transports, decided by what the server actually does:
 *  - `range`: server answers `Range` with 206 → arbitrary byte ranges, resumable after a dropped connection.
 *  - `stream`: server ignores Range → forward-only reader that skips what we do not want (not resumable).
 */
import type { FitsHeader } from '../../types';
import { AwsError, CancelledError } from '../aws/errors';
import { makeHdu, readHeader, type FitsHdu } from './parser';

export const FITS_BLOCK = 2880;

/** Fetch bytes `[start, end]` (inclusive) of the object, or the whole object for `null`. */
export type RangeFetcher = (range: [number, number] | null) => Promise<Response>;

export interface RemoteLimits { stallMs: number; maxResumes: number }
export const DEFAULT_REMOTE_LIMITS: RemoteLimits = { stallMs: 30_000, maxResumes: 2 };

export interface ByteSource {
  readonly mode: 'range' | 'stream';
  readonly totalSize: number | null;
  read(start: number, length: number, onProgress?: (doneInThisRead: number) => void): Promise<Uint8Array>;
  close(): void;
}

function withStall<T>(p: Promise<T>, stallMs: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const stall = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new AwsError(`No data received for ${stallMs / 1000}s: the transfer stalled.`, 'timeout')), stallMs); });
  return Promise.race([p, stall]).finally(() => clearTimeout(t));
}

async function drain(r: Response, out: Uint8Array, offset: number, max: number, isCancelled: () => boolean, stallMs: number, onProgress?: (done: number) => void): Promise<number> {
  if (!r.body) {
    if (isCancelled()) throw new CancelledError();
    const buf = new Uint8Array(await r.arrayBuffer());
    const n = Math.min(buf.length, max);
    out.set(buf.subarray(0, n), offset);
    return n;
  }
  const reader = r.body.getReader();
  let n = 0;
  try {
    while (n < max) {
      if (isCancelled()) throw new CancelledError();
      const { done, value } = await withStall(reader.read(), stallMs);
      if (done || !value) break;
      const k = Math.min(value.length, max - n);
      out.set(value.subarray(0, k), offset + n);
      n += k;
      onProgress?.(offset + n);
    }
  } catch (e) {
    if (isCancelled() || e instanceof CancelledError) throw new CancelledError();
    if (e instanceof AwsError) throw e;
    throw new AwsError(`Connection interrupted after ${n} bytes (${e instanceof Error ? e.message : String(e)}).`, 'network');
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return n;
}

class RangeSource implements ByteSource {
  readonly mode = 'range' as const;
  constructor(private fetcher: RangeFetcher, private first: Uint8Array, readonly totalSize: number | null, private isCancelled: () => boolean, private limits: RemoteLimits) {}
  async read(start: number, length: number, onProgress?: (done: number) => void): Promise<Uint8Array> {
    if (this.totalSize !== null) {
      if (start >= this.totalSize) return new Uint8Array(0);
      length = Math.min(length, this.totalSize - start);
    }
    if (start === 0 && length <= this.first.length) return this.first.subarray(0, length);
    const out = new Uint8Array(length);
    let got = 0;
    let resumes = 0;
    while (got < length) {
      if (this.isCancelled()) throw new CancelledError();
      const r = await this.fetcher([start + got, start + length - 1]);
      if (r.status !== 206) {
        r.body?.cancel().catch(() => undefined);
        throw new AwsError('The server stopped honouring partial (Range) downloads in the middle of the transfer.', 'invalid_response', r.status);
      }
      try {
        got += await drain(r, out, got, length - got, this.isCancelled, this.limits.stallMs, onProgress);
        if (got < length) throw new AwsError(`Download ended early: got ${got} of ${length} bytes.`, 'truncated');
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        if (e instanceof AwsError && (e.transient || e.code === 'truncated') && resumes < this.limits.maxResumes) { resumes++; continue; } // resume from `got`
        throw e;
      }
    }
    return out;
  }
  close(): void { /* stateless */ }
}

class StreamSource implements ByteSource {
  readonly mode = 'stream' as const;
  private pos = 0;
  private buf = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(r: Response, readonly totalSize: number | null, private isCancelled: () => boolean, private limits: RemoteLimits) {
    if (!r.body) throw new AwsError('The server response has no readable body.', 'invalid_response');
    this.reader = r.body.getReader();
  }
  private async fill(): Promise<boolean> {
    try {
      const { done, value } = await withStall(this.reader.read(), this.limits.stallMs);
      if (done || !value) return false;
      this.buf = value;
      return true;
    } catch (e) {
      if (this.isCancelled()) throw new CancelledError();
      if (e instanceof AwsError) throw e;
      throw new AwsError(`Connection interrupted (${e instanceof Error ? e.message : String(e)}).`, 'network');
    }
  }
  async read(start: number, length: number, onProgress?: (done: number) => void): Promise<Uint8Array> {
    if (start < this.pos) throw new Error('Internal error: stream source is forward-only');
    let skip = start - this.pos;
    while (skip > 0) {
      if (this.isCancelled()) throw new CancelledError();
      if (this.buf.length === 0 && !(await this.fill())) return new Uint8Array(0);
      const n = Math.min(skip, this.buf.length);
      this.buf = this.buf.subarray(n);
      skip -= n;
      this.pos += n;
    }
    const out = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      if (this.isCancelled()) throw new CancelledError();
      if (this.buf.length === 0 && !(await this.fill())) break;
      const n = Math.min(length - got, this.buf.length);
      out.set(this.buf.subarray(0, n), got);
      this.buf = this.buf.subarray(n);
      got += n;
      this.pos += n;
      onProgress?.(got);
    }
    return got === length ? out : out.subarray(0, got);
  }
  close(): void { this.reader.cancel().catch(() => undefined); }
}

/** Open a remote FITS file. First block via Range: 206 → Range transport, 200 → server ignores Range → stream. */
export async function openByteSource(fetcher: RangeFetcher, isCancelled: () => boolean, knownTotal: number | null = null, limits: RemoteLimits = DEFAULT_REMOTE_LIMITS): Promise<ByteSource> {
  const r = await fetcher([0, FITS_BLOCK - 1]);
  if (r.status === 206) {
    const cr = Number(/\/(\d+)\s*$/.exec(r.headers.get('content-range') ?? '')?.[1]);
    const total = Number.isFinite(cr) ? cr : knownTotal;
    return new RangeSource(fetcher, new Uint8Array(await r.arrayBuffer()), total, isCancelled, limits);
  }
  const len = Number(r.headers.get('content-length'));
  return new StreamSource(r, knownTotal ?? (Number.isFinite(len) && len > 0 ? len : null), isCancelled, limits);
}

class EndOfFile extends Error {}
export const isEndOfFile = (e: unknown): boolean => e instanceof EndOfFile;

/** Read one HDU header at byte `offset`. Throws an end-of-file marker (see `isEndOfFile`) at a clean end of file. */
export async function readHeaderAt(src: ByteSource, offset: number): Promise<{ header: FitsHeader; end: number }> {
  let acc = new Uint8Array(0);
  for (let blocks = 0; blocks < 64; blocks++) {
    const b = await src.read(offset + acc.length, FITS_BLOCK);
    if (b.length === 0 && acc.length === 0 && offset > 0) throw new EndOfFile();
    if (b.length < FITS_BLOCK) throw new AwsError('The FITS file ended inside a header (truncated download, or not a FITS file).', 'truncated');
    const next = new Uint8Array(acc.length + FITS_BLOCK);
    next.set(acc, 0);
    next.set(b, acc.length);
    acc = next;
    if (offset === 0 && blocks === 0 && new TextDecoder('ascii').decode(acc.subarray(0, 9)) !== 'SIMPLE  =') {
      throw new AwsError('The server did not return a FITS file (the response does not start with SIMPLE).', 'invalid_response');
    }
    try {
      const { header, end } = readHeader(acc, 0);
      return { header, end: offset + end };
    } catch { /* END card not reached yet: read the next block */ }
  }
  throw new AwsError('FITS header has no END card within 64 blocks.', 'invalid_response');
}

/** Offset of the HDU that follows `hdu`, from its header-derived size. */
export const nextHduOffset = (hdu: FitsHdu): number => hdu.dataOffset + Math.ceil(hdu.dataBytes / FITS_BLOCK) * FITS_BLOCK;

export { makeHdu };
export type { FitsHdu };
