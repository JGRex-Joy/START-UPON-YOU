/**
 * Explicit, typed state machine around one All-Sky Cube load (framework-agnostic; the React store subscribes).
 *   idle → discovering → awaiting_download_authorization → downloading → validating → loaded
 *                 ↘ error            ↘ cancelled (from any active state)
 * - Nothing large is downloaded before `authorize()` unless `start({ autoAuthorize: true })` (the app's default now: the user asked for automatic loading).
 * - `cancel()` aborts in-flight requests and releases a pending authorisation.
 * - Stale runs cannot overwrite a newer run's state (run ids). Every failure ends in `error`; nothing waits forever.
 */
import type { CubeInfo, SkyPosition, SpectralCube } from '../../types';
import { loadAllSkyCubeLazy, loadAllSkyCubeTile, type DownloadPlan, type LazyOptions } from '../spherex/allSkyCube';
import { AwsError, CancelledError, type AwsErrorCode } from './errors';

export type CubeLoadState =
  | { status: 'idle' }
  | { status: 'discovering'; stage: string }
  | { status: 'awaiting_download_authorization'; plan: DownloadPlan }
  | { status: 'downloading'; stage: string; received: number; total: number | null }
  | { status: 'validating'; stage: string }
  | { status: 'loaded'; info: CubeInfo }
  | { status: 'error'; message: string; code: AwsErrorCode | 'unknown' }
  | { status: 'cancelled' };

export type CubeLoadStatus = CubeLoadState['status'];
export interface CubeLoadResult { cube: SpectralCube; info: CubeInfo }

export class AllSkyCubeSession {
  private current: CubeLoadState = { status: 'idle' };
  private listeners = new Set<(s: CubeLoadState) => void>();
  private ctl: AbortController | null = null;
  private pendingAuth: ((ok: boolean) => void) | null = null;
  private runId = 0;

  get state(): CubeLoadState { return this.current; }

  subscribe(fn: (s: CubeLoadState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private set(id: number, s: CubeLoadState): void {
    if (id !== this.runId) return;
    this.current = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Begin a load. Resolves with the cube, or null if cancelled / failed (the state says which). */
  async start(pos: SkyPosition, opts: Omit<LazyOptions, 'signal' | 'isCancelled' | 'onProgress' | 'authorize'> & { autoAuthorize?: boolean; full?: boolean } = {}): Promise<CubeLoadResult | null> {
    this.cancel();
    const id = ++this.runId;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.set(id, { status: 'discovering', stage: 'Starting…' });
    const { autoAuthorize, full, ...loadOpts } = opts;
    // Default: on-demand channels (headers + one channel). `full: true` downloads the whole IMAGE layer (after authorisation).
    const loader = full ? loadAllSkyCubeTile : loadAllSkyCubeLazy;
    try {
      const res = await loader(pos, {
        ...loadOpts,
        signal: ctl.signal,
        onProgress: (p) => this.set(id, p.phase === 'downloading'
          ? { status: 'downloading', stage: p.stage, received: p.received, total: p.total }
          : p.phase === 'validating' ? { status: 'validating', stage: p.stage } : { status: 'discovering', stage: p.stage }),
        authorize: (plan) => autoAuthorize ? true : new Promise<boolean>((resolve) => {
          this.pendingAuth = resolve;
          this.set(id, { status: 'awaiting_download_authorization', plan });
        }),
      });
      if (id !== this.runId) return null;
      this.set(id, { status: 'loaded', info: res.info });
      return res;
    } catch (e) {
      if (id !== this.runId) return null;
      if (e instanceof CancelledError || ctl.signal.aborted) this.set(id, { status: 'cancelled' });
      else this.set(id, { status: 'error', message: e instanceof Error ? e.message : String(e), code: e instanceof AwsError ? e.code : 'unknown' });
      return null;
    } finally {
      if (this.ctl === ctl) this.ctl = null;
    }
  }

  authorize(): void { const p = this.pendingAuth; this.pendingAuth = null; p?.(true); }

  cancel(): void {
    const p = this.pendingAuth;
    this.pendingAuth = null;
    p?.(false);
    this.ctl?.abort();
  }

  /** Forget the last outcome and any running load (e.g. when the target changes). */
  reset(): void {
    this.cancel();
    const id = ++this.runId;
    this.set(id, { status: 'idle' });
  }
}
