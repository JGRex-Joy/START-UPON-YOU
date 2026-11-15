import { PROXIED_HOSTS } from '../config/hosts';

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'cors-or-blocked' | 'http' | 'parse' | 'timeout',
    public readonly status?: number,
  ) {
    super(message);
  }
}

async function attempt(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) throw new ServiceError(`Request timed out after ${timeoutMs / 1000}s`, 'timeout');
    // A fetch() TypeError is how browsers report CORS failures, DNS errors and offline state alike.
    throw new ServiceError(e instanceof Error ? e.message : 'Network error', 'cors-or-blocked');
  } finally {
    clearTimeout(t);
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [2_000, 5_000, 12_000];

/**
 * Fetch an archive URL. For hosts with a configured same-origin proxy (IRSA, VizieR, Sesame — none send CORS
 * headers) the proxy is tried FIRST: a direct request would only fail *after* the server has answered, i.e. after
 * the full wait. The direct request is the fallback (works when the app is served behind a different proxy
 * or the archive adds CORS headers). Never silently swallows errors.
 */
export async function fetchWithProxyFallback(url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
  const host = PROXIED_HOSTS.find((h) => url.startsWith(h.origin));
  let proxyNote = 'No proxy is configured for this host.';
  if (host) {
    const proxied = `${host.prefix}${url.slice(host.origin.length)}`;
    try {
      let r = await attempt(proxied, init, timeoutMs);
      // Archives (IRSA's cutout service in particular) answer 503/429 under load; back off and retry a few times.
      for (let i = 0; i < RETRY_DELAYS_MS.length && RETRYABLE_STATUS.has(r.status); i++) {
        const ra = Number(r.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : RETRY_DELAYS_MS[i];
        await new Promise((res) => setTimeout(res, wait));
        r = await attempt(proxied, init, timeoutMs);
      }
      const type = r.headers.get('content-type') ?? '';
      if (r.ok && !type.includes('text/html')) return r;
      if (r.ok) {
        proxyNote = `Proxy ${host.prefix} returned the app's own HTML page instead of archive data — the dev-server proxy is not active (is vite.config.ts from this project in use, and was the dev server restarted?).`;
      } else {
        const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
        // A real archive error (bad query, service down) will not be fixed by a direct request.
        const hostless = r.status === 404 && (/NOT_FOUND|could not be found/i.test(body) || !!r.headers.get('x-vercel-id'));
        throw new ServiceError(`${host.label} answered HTTP ${r.status} via proxy${body ? `: ${body}` : ''}${hostless ? ` — this looks like YOUR HOSTING's 404, not the archive's: the ${host.prefix} rewrite is not deployed (see vercel.json / public/_redirects).` : ''}`, 'http', r.status);
      }
    } catch (e) {
      if (e instanceof ServiceError && e.kind === 'http') throw e;
      proxyNote = `Proxy ${host.prefix} failed: ${e instanceof Error ? e.message : String(e)}.`;
    }
  }
  try {
    const r = await attempt(url, init, host ? Math.min(timeoutMs, 20_000) : timeoutMs);
    if (r.ok) return r;
    throw new ServiceError(`HTTP ${r.status} ${r.statusText} from ${new URL(url).host}`, 'http', r.status);
  } catch (e) {
    if (e instanceof ServiceError && e.kind === 'http') throw e;
    throw new ServiceError(
      `${proxyNote} Direct request to ${new URL(url).host} also failed (${e instanceof Error ? e.message : String(e)}; IRSA sends no CORS headers, so this is expected in a browser).`,
      'cors-or-blocked',
    );
  }
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
