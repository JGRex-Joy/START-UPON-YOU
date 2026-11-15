/**
 * HEALPix NESTED pixel index of a sky position (Górski et al. 2005, `ang2pix_nest`).
 * Dependency-free; cross-checked against `hpgeom.angle_to_pixel(nside, ra, dec, nest=True)` in tests/run.ts.
 */
function spreadBits(v: number): number {
  let r = 0;
  for (let b = 0; b < 15; b++) r |= ((v >> b) & 1) << (2 * b);
  return r;
}

export function healpixNestedIndex(order: number, raDeg: number, decDeg: number): number {
  if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || Math.abs(decDeg) > 90) throw new Error('Invalid sky position for HEALPix lookup');
  const nside = 1 << order;
  // z = cos(colatitude), computed like healpy/hpgeom do so that exact pixel-corner positions break ties identically.
  const z = Math.cos(Math.PI / 2 - (decDeg * Math.PI) / 180);
  const za = Math.abs(z);
  const phi = ((((raDeg % 360) + 360) % 360) * Math.PI) / 180;
  const tt = phi / (Math.PI / 2); // [0, 4)
  let face: number;
  let ix: number;
  let iy: number;
  if (za <= 2 / 3) {
    // equatorial region
    const temp1 = nside * (0.5 + tt);
    const temp2 = nside * z * 0.75;
    const jp = Math.floor(temp1 - temp2);
    const jm = Math.floor(temp1 + temp2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    face = ifp === ifm ? (ifp | 4) : ifp < ifm ? ifp : ifm + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    // polar caps
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(Math.floor(tp * tmp), nside - 1);
    const jm = Math.min(Math.floor((1 - tp) * tmp), nside - 1);
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; }
    else { face = ntt + 8; ix = jp; iy = jm; }
  }
  return face * nside * nside + spreadBits(ix) + (spreadBits(iy) << 1);
}
