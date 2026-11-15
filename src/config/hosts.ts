/**
 * External archive hosts the app talks to, and the same-origin proxy prefix used
 * as a fallback when the browser blocks a direct request (CORS / network policy).
 *
 * The Vite dev server proxies every `prefix` to its `origin` (see vite.config.ts).
 * For a production deployment, configure the same prefixes on your reverse proxy
 * (nginx, Cloudflare Worker, ...) — no application backend is required.
 */
export interface ProxiedHost {
  origin: string;
  prefix: string;
  label: string;
}

export const PROXIED_HOSTS: readonly ProxiedHost[] = [
  { origin: 'https://irsa.ipac.caltech.edu', prefix: '/proxy/irsa', label: 'NASA/IPAC IRSA' },
  { origin: 'https://tapvizier.cds.unistra.fr', prefix: '/proxy/vizier', label: 'CDS VizieR TAP' },
  { origin: 'https://cds.unistra.fr', prefix: '/proxy/cds', label: 'CDS Sesame' },
  /** Public SPHEREx bucket (anonymous). Used only as a fallback route if the browser blocks direct S3 requests (CORS). */
  { origin: 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com', prefix: '/proxy/s3spherex', label: 'AWS S3 nasa-irsa-spherex' },
] as const;
