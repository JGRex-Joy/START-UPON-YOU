/**
 * Sky-map selection <-> URL hash. Pure functions (unit-tested); the page applies them.
 *   #/sky?t=barnards-star          a featured challenge target (coordinates come from services/targets.ts, never the URL)
 *   #/sky?ra=133.79513&dec=-7.24515  any sky position, decimal degrees (ICRS)
 */
import { CHALLENGE_TARGETS } from '../services/targets';
import { parseDec, parseRa } from '../utils/coords';
import type { ChallengeTarget, SkyPosition } from '../types';

export interface SkySelection {
  pos: SkyPosition;
  challenge: ChallengeTarget | null;
}

export type SkyHashResult = { kind: 'none' } | { kind: 'ok'; selection: SkySelection } | { kind: 'invalid'; error: string };

export function parseSkyHash(hash: string): SkyHashResult {
  const q = hash.split('?')[1];
  if (!q) return { kind: 'none' };
  const params = new URLSearchParams(q);
  const t = params.get('t');
  if (t) {
    const target = CHALLENGE_TARGETS.find((x) => x.id === t);
    if (!target) return { kind: 'invalid', error: `Unknown target "${t}" in the link.` };
    return { kind: 'ok', selection: { pos: { ra: target.ra, dec: target.dec }, challenge: target } };
  }
  const ra = params.get('ra');
  const dec = params.get('dec');
  if (ra === null && dec === null) return { kind: 'none' };
  const r = parseRa(ra ?? '');
  const d = parseDec(dec ?? '');
  if (!r.ok) return { kind: 'invalid', error: `RA in the link is not valid: ${r.error}` };
  if (!d.ok) return { kind: 'invalid', error: `Dec in the link is not valid: ${d.error}` };
  return { kind: 'ok', selection: { pos: { ra: r.value, dec: d.value }, challenge: null } };
}

export function buildSkyHash(sel: SkySelection | null): string {
  if (!sel) return '#/';
  if (sel.challenge) return `#/sky?t=${sel.challenge.id}`;
  return `#/sky?ra=${sel.pos.ra.toFixed(5)}&dec=${sel.pos.dec.toFixed(5)}`;
}
