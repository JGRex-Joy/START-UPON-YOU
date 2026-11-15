import type { SkyPosition } from '../types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const SEX_RE = /^\s*([+-]?)\s*(\d+(?:\.\d+)?)\s*[:hHdD°\s]\s*(\d+(?:\.\d+)?)?\s*[:mM'′\s]?\s*(\d+(?:\.\d+)?)?\s*[sS"″]?\s*$/;

/** Parse a number in decimal degrees or sexagesimal ("08 55 10.831", "08h55m10.831s", "-07:14:42.53"). */
function parseAngle(text: string, isRa: boolean): ParseResult<number> {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Required' };
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) {
    return { ok: true, value: Number(t) };
  }
  const hasHms = /[hH]/.test(t) || (isRa && /[:\s]/.test(t));
  const m = SEX_RE.exec(t);
  if (!m) return { ok: false, error: 'Use decimal degrees or sexagesimal (e.g. 08h55m10.8s)' };
  const sign = m[1] === '-' ? -1 : 1;
  const a = Number(m[2]);
  const b = m[3] ? Number(m[3]) : 0;
  const c = m[4] ? Number(m[4]) : 0;
  if (b >= 60 || c >= 60) return { ok: false, error: 'Minutes and seconds must be below 60' };
  const base = a + b / 60 + c / 3600;
  const value = isRa && hasHms ? base * 15 : base;
  return { ok: true, value: sign * value };
}

export function parseRa(text: string): ParseResult<number> {
  const r = parseAngle(text, true);
  if (!r.ok) return r;
  if (r.value < 0 || r.value >= 360) return { ok: false, error: 'RA must be in [0, 360) degrees' };
  return r;
}

export type RaUnit = 'deg' | 'hours';

/**
 * RA entry with an explicit unit. In 'hours' mode a plain number is hours (0 ≤ h < 24, ×15 to degrees); sexagesimal
 * input ("08h55m10.8s", "08 55 10.8") is hours in either mode. In 'deg' mode behaviour is exactly `parseRa`.
 */
export function parseRaUnit(text: string, unit: RaUnit): ParseResult<number> {
  if (unit === 'hours' && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(text)) {
    const h = Number(text);
    if (h < 0 || h >= 24) return { ok: false, error: 'RA must be in [0, 24) hours' };
    return { ok: true, value: h * 15 };
  }
  return parseRa(text);
}

export function parseDec(text: string): ParseResult<number> {
  const r = parseAngle(text, false);
  if (!r.ok) return r;
  if (r.value < -90 || r.value > 90) return { ok: false, error: 'Dec must be within ±90 degrees' };
  return r;
}

export function parsePosition(raText: string, decText: string, raUnit: RaUnit = 'deg'): ParseResult<SkyPosition> {
  const ra = parseRaUnit(raText, raUnit);
  const dec = parseDec(decText);
  if (!ra.ok) return { ok: false, error: `RA: ${ra.error}` };
  if (!dec.ok) return { ok: false, error: `Dec: ${dec.error}` };
  return { ok: true, value: { ra: ra.value, dec: dec.value } };
}

const pad = (n: number, w: number, d = 0) => n.toFixed(d).padStart(w + (d ? d + 1 : 0), '0');

export function formatRaHms(raDeg: number, decimals = 2): string {
  const h = (((raDeg % 360) + 360) % 360) / 15;
  let hh = Math.floor(h);
  let mm = Math.floor((h - hh) * 60);
  let ss = ((h - hh) * 60 - mm) * 60;
  if (Number(ss.toFixed(decimals)) >= 60) {
    ss = 0;
    mm += 1;
  }
  if (mm >= 60) {
    mm = 0;
    hh = (hh + 1) % 24;
  }
  return `${pad(hh, 2)}h ${pad(mm, 2)}m ${pad(ss, 2, decimals)}s`;
}

export function formatDecDms(decDeg: number, decimals = 1): string {
  const sign = decDeg < 0 ? '−' : '+';
  const a = Math.abs(decDeg);
  let dd = Math.floor(a);
  let mm = Math.floor((a - dd) * 60);
  let ss = ((a - dd) * 60 - mm) * 60;
  if (Number(ss.toFixed(decimals)) >= 60) {
    ss = 0;
    mm += 1;
  }
  if (mm >= 60) {
    mm = 0;
    dd += 1;
  }
  return `${sign}${pad(dd, 2)}° ${pad(mm, 2)}′ ${pad(ss, 2, decimals)}″`;
}

export const formatDeg = (v: number, d = 5) => v.toFixed(d);

/** Angular separation in arcseconds (haversine). */
export function separationArcsec(a: SkyPosition, b: SkyPosition): number {
  const r = Math.PI / 180;
  const dRa = (b.ra - a.ra) * r;
  const dDec = (b.dec - a.dec) * r;
  const h = Math.sin(dDec / 2) ** 2 + Math.cos(a.dec * r) * Math.cos(b.dec * r) * Math.sin(dRa / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * (180 / Math.PI) * 3600;
}

/**
 * Linear proper-motion propagation (small-angle). pm in mas/yr; years = target - catalog epoch.
 * Ignores parallax and radial-velocity terms — adequate for tens of years at arcsecond level.
 */
export function propagate(
  pos: SkyPosition,
  pmRaCosDec: number | null,
  pmDec: number | null,
  years: number,
): SkyPosition {
  if (pmRaCosDec === null || pmDec === null) return pos;
  const cosd = Math.max(1e-6, Math.cos((pos.dec * Math.PI) / 180));
  return {
    ra: (pos.ra + (pmRaCosDec * years) / 3.6e6 / cosd + 360) % 360,
    dec: Math.max(-90, Math.min(90, pos.dec + (pmDec * years) / 3.6e6)),
  };
}
