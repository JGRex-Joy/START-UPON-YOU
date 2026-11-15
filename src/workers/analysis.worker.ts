/// <reference lib="webworker" />
import { detectSources } from '../engines/sourceDetection';
import { subtractImages } from '../engines/imageSubtraction';
import type { FitsImage } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'detect') {
      const result = detectSources(req.data, req.width, req.height, req.wcs, req.options);
      const res: WorkerResponse = { id: req.id, type: 'detect', result };
      ctx.postMessage(res);
    } else {
      const result = subtractImages(req.i1 as FitsImage, req.i2 as FitsImage, req.options);
      const res: WorkerResponse = { id: req.id, type: 'subtract', result };
      ctx.postMessage(res, [result.data.buffer]);
    }
  } catch (e) {
    const res: WorkerResponse = { id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) };
    ctx.postMessage(res);
  }
};
