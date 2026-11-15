/**
 * Anonymous access to the public SPHEREx bucket (`nasa-irsa-spherex`, us-east-1).
 *
 * Dependency-free: plain `fetch` against the virtual-hosted S3 endpoint. Requests are never signed and never carry
 * credentials. Capabilities used: GET (with `Range`), HEAD and ListObjectsV2.
 *
 * Routing: DIRECT first, then the same-origin proxy `/proxy/s3spherex` (see `config/hosts.ts`) if a browser blocks the
 * direct request (CORS). The route that worked is remembered. Nothing here talks to IRSA.
 */
import { PROXIED_HOSTS } from '../../config/hosts';
import { AwsError, CancelledError, errorFromStatus } from './errors';

export const S3_BUCKET = 'nasa-irsa-spherex';
export const S3_REGION = 'us-east-1';
export const DEFAULT_S3_ORIGIN = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;

export interface S3Config {
  origin: string;
  proxyPrefix: string | null;
  /** Time allowed until response headers arrive. */
  timeoutMs: number;
  /** Retries (with these delays) for transient HTTP failures (429/5xx). */
  retryDelaysMs: number[];
}

const proxy = PROXIED_HOSTS.find((h) => h.origin === DEFAULT_S3_ORIGIN);
const DEFAULTS: S3Config = { origin: DEFAULT_S3_ORIGIN, proxyPrefix: proxy?.prefix ?? null, timeoutMs: 60_000, retryDelaysMs: [1_000, 3_000, 8_000] };
let config: S3Config = { ...DEFAULTS };
let routeMemo: 'direct' | 'proxy' | null = null;

/** Override transport settings (tests point `origin` at a mock). */
export function configureS3(partial: Partial<S3Config>): void { config = { ...config, ...partial }; routeMemo = null; }
export function resetS3Config(): void { config = { ...DEFAULTS }; routeMemo = null; }
export function getS3Config(): Readonly<S3Config> { return config; }

const keyToPath = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

/** Public URL of an object (what a user can paste into curl/wget). */
export function s3ObjectUrl(key: string, origin: string = config.origin): string {
  return `${origin}/${keyToPath(key)}`;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new CancelledError());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new CancelledError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export interface S3RequestOptions {
  method?: 'GET' | 'HEAD';
  /** Inclusive byte range. */
  range?: [number, number] | null;
  query?: Record<string, string>;
  signal?: AbortSignal;
}

interface Route { name: 'direct' | 'proxy'; url: string }

function routesFor(path: string, qs: string): Route[] {
  const direct: Route = { name: 'direct', url: `${config.origin}${path}${qs}` };
  const inBrowser = typeof location !== 'undefined';
  const prox: Route[] = config.proxyPrefix && inBrowser ? [{ name: 'proxy', url: `${config.proxyPrefix}${path}${qs}` }] : [];
  const all = [direct, ...prox];
  return routeMemo ? [...all].sort((a, b) => Number(b.name === routeMemo) - Number(a.name === routeMemo)) : all;
}

async function bodyHint(r: Response): Promise<string> {
  try {
    const t = (await r.text()).slice(0, 600);
    const code = /<Code>([^<]+)<\/Code>/.exec(t)?.[1];
    const msg = /<Message>([^<]+)<\/Message>/.exec(t)?.[1];
    return [code, msg].filter(Boolean).join(': ');
  } catch { return ''; }
}

/** One logical S3 request with route fallback and retries for transient failures. Resolves only for 2xx. */
export async function s3Request(key: string, opts: S3RequestOptions = {}): Promise<Response> {
  const path = key ? `/${keyToPath(key)}` : '/';
  const qs = opts.query ? `?${Object.entries(opts.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
  const what = key ? `s3://${S3_BUCKET}/${key}` : `s3://${S3_BUCKET} listing`;
  const headers: Record<string, string> = {};
  if (opts.range) headers['Range'] = `bytes=${opts.range[0]}-${opts.range[1]}`;
  let retries = 0;
  let networkRetried = false;

  for (;;) {
    if (opts.signal?.aborted) throw new CancelledError();
    let answered: { route: Route; response: Response } | null = null;
    const failures: string[] = [];

    for (const route of routesFor(path, qs)) {
      const ctl = new AbortController();
      let timedOut = false;
      const onAbort = () => ctl.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, config.timeoutMs);
      try {
        const r = await fetch(route.url, { method: opts.method ?? 'GET', headers, signal: ctl.signal, credentials: 'omit' });
        // A same-origin proxy that is not running answers with the app's own HTML page: that is "no route", not data.
        if (route.name === 'proxy' && r.ok && (r.headers.get('content-type') ?? '').includes('text/html')) {
          r.body?.cancel().catch(() => undefined);
          failures.push(`proxy ${config.proxyPrefix} is not active (returned the app's HTML page)`);
          continue;
        }
        answered = { route, response: r };
        break;
      } catch (e) {
        if (opts.signal?.aborted) throw new CancelledError();
        if (timedOut) throw new AwsError(`${what}: no response within ${config.timeoutMs / 1000}s.`, 'timeout', undefined, key || undefined);
        failures.push(`${route.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }

    if (!answered) {
      if (!networkRetried && config.retryDelaysMs.length > 0) { networkRetried = true; await sleep(config.retryDelaysMs[0], opts.signal); continue; }
      throw new AwsError(
        `${what}: could not reach AWS S3 (${failures.join('; ')}). Check the network connection; in a browser this also happens when the bucket sends no CORS headers and the same-origin proxy is not configured.`,
        'network', undefined, key || undefined,
      );
    }

    const { route, response } = answered;
    if (response.ok) { routeMemo = route.name; return response; }
    const hint = opts.method === 'HEAD' ? '' : await bodyHint(response);
    const err = errorFromStatus(response.status, what, key || undefined, hint);
    routeMemo = route.name;
    if (err.transient && retries < config.retryDelaysMs.length) {
      const ra = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : config.retryDelaysMs[retries];
      retries++;
      await sleep(wait, opts.signal);
      continue;
    }
    throw err;
  }
}

export interface S3ObjectInfo { key: string; size: number | null; etag: string | null; lastModified: string | null }

export async function headObject(key: string, signal?: AbortSignal): Promise<S3ObjectInfo> {
  const r = await s3Request(key, { method: 'HEAD', signal });
  const len = Number(r.headers.get('content-length'));
  return { key, size: r.headers.has('content-length') && Number.isFinite(len) ? len : null, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified') };
}

export interface S3Listing {
  prefixes: string[];
  objects: { key: string; size: number; lastModified: string | null }[];
  truncated: boolean;
}

const decodeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

export function parseListing(xml: string): S3Listing & { nextToken: string | null } {
  if (!/<ListBucketResult[\s>]/.test(xml)) {
    const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
    throw new AwsError(`S3 did not return a bucket listing${code ? ` (${code})` : ''}.`, 'invalid_response');
  }
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)].map((m) => decodeXml(m[1]));
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
    key: decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] ?? ''),
    size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? NaN),
    lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] ?? null,
  }));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { prefixes, objects, truncated, nextToken: nextToken ? decodeXml(nextToken) : null };
}

export interface ListOptions { delimiter?: string; maxKeys?: number; signal?: AbortSignal; maxPages?: number }

/** Anonymous ListObjectsV2. Follows continuation tokens up to `maxPages` (default 5). */
export async function listObjects(prefix: string, opts: ListOptions = {}): Promise<S3Listing> {
  const out: S3Listing = { prefixes: [], objects: [], truncated: false };
  let token: string | null = null;
  for (let page = 0; page < (opts.maxPages ?? 5); page++) {
    const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': String(opts.maxKeys ?? 1000) };
    if (opts.delimiter) query['delimiter'] = opts.delimiter;
    if (token) query['continuation-token'] = token;
    const r = await s3Request('', { query, signal: opts.signal });
    const p = parseListing(await r.text());
    out.prefixes.push(...p.prefixes);
    out.objects.push(...p.objects);
    if (!p.truncated || !p.nextToken) return out;
    token = p.nextToken;
  }
  out.truncated = true;
  return out;
}
