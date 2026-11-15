import { useMemo } from 'react';

/** Deterministic PRNG, so the sky is the same on every visit (and in screenshots). */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layer(seed: number, count: number, alpha: [number, number]): string {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = (rnd() * 100).toFixed(2);
    const y = (rnd() * 100).toFixed(2);
    const a = (alpha[0] + rnd() * (alpha[1] - alpha[0])).toFixed(2);
    out.push(`${x}vw ${y}vh 0 0 rgba(232,237,245,${a})`);
  }
  return out.join(', ');
}

/**
 * A quiet field of stars: three static box-shadow layers (one painted element each — no canvas, no per-frame work).
 * Only the faintest layer breathes, and the global reduced-motion rule stops even that.
 */
export function StarField() {
  const layers = useMemo(() => [layer(7, 150, [0.25, 0.6]), layer(21, 60, [0.45, 0.85]), layer(99, 16, [0.7, 1])], []);
  return (
    <div className="starfield" aria-hidden="true">
      <i className="starfield__l starfield__l--1" style={{ boxShadow: layers[0] }} />
      <i className="starfield__l starfield__l--2" style={{ boxShadow: layers[1] }} />
      <i className="starfield__l starfield__l--3" style={{ boxShadow: layers[2] }} />
    </div>
  );
}
