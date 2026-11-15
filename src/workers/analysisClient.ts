import type { DetectionResult, DifferenceResult, FitsImage, Wcs } from '../types';
import { detectSources, type DetectionOptions } from '../engines/sourceDetection';
import { subtractImages, type SubtractionOptions } from '../engines/imageSubtraction';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Promise-based client for the analysis worker. If Workers are unavailable
 * (or fail to start) the same engines run on the main thread.
 */
class AnalysisClient {
  private worker: Worker | null = null;
  private failed = false;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }>();

  private ensure(): Worker | null {
    if (this.failed) return null;
    if (this.worker) return this.worker;
    try {
      const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.type === 'error') p.reject(new Error(ev.data.message));
        else p.resolve(ev.data);
      };
      w.onerror = () => {
        this.failed = true;
        this.worker = null;
        for (const [, p] of this.pending) p.reject(new Error('Analysis worker crashed'));
        this.pending.clear();
      };
      this.worker = w;
      return w;
    } catch {
      this.failed = true;
      return null;
    }
  }

  private call(build: (id: number) => WorkerRequest): Promise<WorkerResponse> {
    const w = this.ensure();
    if (!w) return Promise.reject(new Error('no-worker'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage(build(id));
    });
  }

  async detect(image: FitsImage, options: DetectionOptions): Promise<DetectionResult> {
    try {
      const r = await this.call((id) => ({
        id, type: 'detect', data: image.data.slice(), width: image.width, height: image.height, wcs: image.wcs, options,
      }));
      if (r.type === 'detect') return r.result;
      throw new Error('Unexpected worker response');
    } catch (e) {
      if (e instanceof Error && e.message === 'no-worker') return detectSources(image.data, image.width, image.height, image.wcs, options);
      throw e;
    }
  }

  async subtract(i1: FitsImage, i2: FitsImage, options: SubtractionOptions): Promise<DifferenceResult> {
    const slim = (i: FitsImage) => ({ ...i, data: i.data.slice() });
    try {
      const r = await this.call((id) => ({ id, type: 'subtract', i1: slim(i1), i2: slim(i2), options }));
      if (r.type === 'subtract') return r.result;
      throw new Error('Unexpected worker response');
    } catch (e) {
      if (e instanceof Error && e.message === 'no-worker') return subtractImages(i1, i2, options);
      throw e;
    }
  }
}

export const analysis = new AnalysisClient();
export type { Wcs };
