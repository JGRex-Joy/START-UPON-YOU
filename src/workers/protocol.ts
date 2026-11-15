import type { DetectionResult, DifferenceResult, FitsImage, Wcs } from '../types';
import type { DetectionOptions } from '../engines/sourceDetection';
import type { SubtractionOptions } from '../engines/imageSubtraction';

export type WorkerRequest =
  | { id: number; type: 'detect'; data: Float32Array; width: number; height: number; wcs: Wcs | null; options: DetectionOptions }
  | { id: number; type: 'subtract'; i1: Pick<FitsImage, 'width' | 'height' | 'data' | 'header' | 'wcs' | 'extname' | 'bunit'>; i2: Pick<FitsImage, 'width' | 'height' | 'data' | 'header' | 'wcs' | 'extname' | 'bunit'>; options: SubtractionOptions };

export type WorkerResponse =
  | { id: number; type: 'detect'; result: DetectionResult }
  | { id: number; type: 'subtract'; result: DifferenceResult }
  | { id: number; type: 'error'; message: string };
