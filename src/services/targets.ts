import type { ChallengeTarget } from '../types';

/**
 * The five challenge targets. Coordinates are J2000 / ICRS. Nothing here is invented:
 *  - WISE 0855: supplied in the challenge brief.
 *  - Others: taken from the cited public sources (retrieved while building the prototype).
 * `precision` states how exact each stored position is. Fast movers (Barnard's Star, ε Indi B,
 * WISE 0855) have moved by many arcseconds since J2000 — see `pmRa`/`pmDec` and the
 * proper-motion propagation in the Explorer, or resolve a current position from Gaia/SIMBAD.
 */
export const CHALLENGE_TARGETS: readonly ChallengeTarget[] = [
  {
    id: 'barnards-star',
    name: "Barnard's Star",
    ra: (17 + 57 / 60 + 48.49847 / 3600) * 15,
    dec: 4 + 41 / 60 + 36.1139 / 3600,
    raSexagesimal: '17h 57m 48.49847s',
    decSexagesimal: '+04° 41′ 36.1139″',
    pmRa: -801.551,
    pmDec: 10362.394,
    kind: 'Red dwarf · highest proper motion known',
    focus: 'motion',
    note: 'Moves ~10.4″/yr: ~280″ since J2000. A search at the J2000 position can miss it in recent SPHEREx data.',
    source: { label: 'Wikipedia infobox (J2000, ICRS; Gaia DR3-derived)', url: 'https://en.wikipedia.org/wiki/Barnard%27s_Star' },
    precision: '0.1 mas (as quoted)',
  },
  {
    id: 'eps-indi-b',
    name: 'Epsilon Indi B',
    ra: (22 + 4 / 60 + 10.6 / 3600) * 15,
    dec: -(56 + 46 / 60 + 58.2 / 3600),
    raSexagesimal: '22h 04m 10.6s',
    decSexagesimal: '−56° 46′ 58.2″',
    pmRa: 3981.977,
    pmDec: -2466.832,
    kind: 'Brown dwarf binary (Ba/Bb), 3.6 pc',
    focus: 'motion',
    note: 'Separated by ~0.7″ (Ba–Bb); unresolved at SPHEREx 6.15″ pixels. Stored position is low-precision (0.1 s / 0.1″) — Gaia/SIMBAD refinement recommended.',
    source: { label: 'exoplanet.eu host entry "eps Ind B" (RA/Dec 2000); proper motion from Wikipedia', url: 'https://exoplanet.eu/catalog/eps_ind_bb--10261/' },
    precision: '~0.1 s in RA, 0.1″ in Dec at J2000',
  },
  {
    id: 'wise-0855',
    name: 'WISE 0855−0714',
    ra: (8 + 55 / 60 + 10.831 / 3600) * 15,
    dec: -(7 + 14 / 60 + 42.53 / 3600),
    raSexagesimal: '08h 55m 10.831s',
    decSexagesimal: "−07° 14′ 42.53″",
    pmRa: null,
    pmDec: null,
    kind: 'Coldest known brown dwarf (~285 K), ~2.3 pc',
    focus: 'motion',
    note: 'Coordinates as supplied in the challenge brief. Large proper motion; not recorded here, so no propagation is applied.',
    source: { label: 'Challenge brief (supplied coordinates)', url: 'https://irsa.ipac.caltech.edu/Missions/spherex.html' },
    precision: 'as supplied',
  },
  {
    id: 'rw-aur',
    name: 'RW Aurigae',
    ra: (5 + 7 / 60 + 49.4562 / 3600) * 15,
    dec: 30 + 24 / 60 + 4.774 / 3600,
    raSexagesimal: '05h 07m 49.4562s',
    decSexagesimal: '+30° 24′ 04.774″',
    pmRa: 2.641,
    pmDec: -27.398,
    kind: 'T Tauri variable (young multiple system)',
    focus: 'variability',
    note: 'Famously irregular dimming events — a natural target for temporal comparison. Position is RW Aur A.',
    source: { label: 'Wikipedia infobox (J2000)', url: 'https://en.wikipedia.org/wiki/RW_Aurigae' },
    precision: '0.1 mas (as quoted)',
  },
  {
    id: 'r-dra',
    name: 'R Draconis',
    ra: (16 + 32 / 60 + 40 / 3600) * 15,
    dec: 66 + 45 / 60 + 17 / 3600,
    raSexagesimal: '16h 32m 40s',
    decSexagesimal: '+66° 45′ 17″',
    pmRa: null,
    pmDec: null,
    kind: 'Mira-type long-period variable (P ≈ 245.6 d)',
    focus: 'variability',
    note: 'Large-amplitude pulsator, ~8 months period — brightness changes between epochs are expected. Stored position has 1-second / 1″ precision.',
    source: { label: 'British Astronomical Association VSS object list (epoch 2000)', url: 'https://britastro.org/vss/obj-dra.html' },
    precision: '1 s in RA, 1″ in Dec',
  },
] as const;

/** Why each target is a challenge target: derived from the notes above (large proper motion vs. variable star). */
export const FOCUS_LABEL: Record<ChallengeTarget['focus'], string> = {
  motion: 'Motion investigation',
  variability: 'Variability investigation',
};

export function findTarget(id: string): ChallengeTarget | undefined {
  return CHALLENGE_TARGETS.find((t) => t.id === id);
}
