import type { Wcs } from '../../types';
import { pixelScaleArcsec, pixelToSky, skyToPixel } from '../../services/fits/wcs';

/** center in pixel-centre coordinates (pixel i has its centre at i); zoom = screen px per image px. */
export interface ViewState {
  cx: number;
  cy: number;
  zoom: number;
}

export interface ViewImage {
  width: number;
  height: number;
  wcs: Wcs | null;
}

export type MarkerKind = 'candidate' | 'gaia' | 'wise' | 'mover' | 'target';
export interface Marker {
  id: string;
  x: number;
  y: number;
  kind: MarkerKind;
  label?: string;
  selected?: boolean;
}

export function fitView(img: ViewImage, w: number, h: number): ViewState {
  const z = Math.min(w / img.width, h / img.height) * 0.94;
  return { cx: (img.width - 1) / 2, cy: (img.height - 1) / 2, zoom: Math.max(0.05, z) };
}

/**
 * Translate a view from one image to another so that the same sky region is shown.
 * Uses WCS (and pixel scale) when both images have one, else assumes identical pixel grids.
 */
export function mapView(v: ViewState, from: ViewImage, to: ViewImage): ViewState {
  if (from.wcs && to.wcs) {
    const sky = pixelToSky(from.wcs, v.cx, v.cy);
    const p = skyToPixel(to.wcs, sky.ra, sky.dec);
    if (p) return { cx: p.x, cy: p.y, zoom: v.zoom * (pixelScaleArcsec(from.wcs) / pixelScaleArcsec(to.wcs)) };
  }
  if (from.width === to.width && from.height === to.height) return v;
  return { cx: (v.cx / from.width) * to.width, cy: (v.cy / from.height) * to.height, zoom: v.zoom * (from.width / to.width) };
}

const NICE_ARCSEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000];

export function niceStepDeg(spanDeg: number, targetLines = 5): number {
  const want = (spanDeg * 3600) / targetLines;
  const pick = NICE_ARCSEC.find((s) => s >= want) ?? NICE_ARCSEC[NICE_ARCSEC.length - 1];
  return pick / 3600;
}
