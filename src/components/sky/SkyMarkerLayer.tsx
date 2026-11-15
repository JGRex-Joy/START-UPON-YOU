import { useEffect, useRef, useState } from 'react';
import type { AladinView } from '../../services/aladin';
import type { SkyPosition } from '../../types';

/** A labelled position drawn over the Aladin view (DOM, so it is keyboard-focusable, hoverable and testable). */
export interface SkyMarker {
  id: string;
  name: string;
  pos: SkyPosition;
  /** Scientific focus -> marker shape. */
  focus: 'motion' | 'variability';
  /** Short second line of the tooltip. */
  detail?: string;
  active?: boolean;
}

interface Placed { x: number; y: number }

/**
 * Projects markers (and the selected position) with Aladin's own `world2pix`, so they always sit where the map draws that
 * sky position. Repositions on every Aladin position/zoom change, once per animation frame.
 */
export function SkyMarkerLayer({ view, host, markers, selection, onMarkerClick }: {
  view: AladinView | null;
  host: HTMLElement | null;
  markers: readonly SkyMarker[];
  selection: SkyPosition | null;
  onMarkerClick?: (id: string) => void;
}) {
  const [placed, setPlaced] = useState<{ markers: Record<string, Placed | null>; selection: Placed | null }>({ markers: {}, selection: null });
  const latest = useRef({ markers, selection });
  latest.current = { markers, selection };
  const raf = useRef(0);
  const schedule = useRef<() => void>(() => {});

  useEffect(() => {
    if (!view || !host || typeof view.world2pix !== 'function') return;
    const project = (p: SkyPosition): Placed | null => {
      let xy: [number, number] | null | undefined;
      try { xy = view.world2pix?.(p.ra, p.dec); } catch { xy = null; }
      if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return null;
      if (xy[0] < -20 || xy[1] < -20 || xy[0] > host.clientWidth + 20 || xy[1] > host.clientHeight + 20) return null;
      return { x: xy[0], y: xy[1] };
    };
    const update = () => {
      raf.current = 0;
      const { markers: ms, selection: sel } = latest.current;
      const next: Record<string, Placed | null> = {};
      for (const m of ms) next[m.id] = project(m.pos);
      setPlaced({ markers: next, selection: sel ? project(sel) : null });
    };
    const run = () => { if (!raf.current) raf.current = requestAnimationFrame(update); };
    schedule.current = run;
    for (const ev of ['positionChanged', 'zoomChanged', 'redrawFinished']) view.on?.(ev, run);
    window.addEventListener('resize', run);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(run) : null;
    ro?.observe(host);
    run();
    return () => {
      schedule.current = () => {};
      window.removeEventListener('resize', run);
      ro?.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [view, host]);

  // The camera events above only fire when the view moves: re-project when the marker list or selection changes.
  useEffect(() => { schedule.current(); }, [markers, selection?.ra, selection?.dec]);

  return (
    <div className="skymarks" aria-label="Featured targets on the map">
      {selection && placed.selection && (
        <div className="skymark-sel" data-testid="selected-position" style={{ transform: `translate(${placed.selection.x}px, ${placed.selection.y}px)` }} aria-hidden="true">
          <span className="skymark-sel__ring" />
          <span className="skymark-sel__dot" />
        </div>
      )}
      {markers.map((m) => {
        const p = placed.markers[m.id];
        if (!p) return null;
        return (
          <button
            key={m.id} type="button" data-testid={`marker-${m.id}`} data-focus={m.focus}
            className={`skymark skymark--${m.focus} ${m.active ? 'is-active' : ''}`}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            aria-label={`${m.name} — ${m.focus === 'motion' ? 'motion investigation' : 'variability investigation'}`}
            aria-pressed={!!m.active}
            onClick={(e) => { e.stopPropagation(); onMarkerClick?.(m.id); }}
          >
            <span className="skymark__glyph" aria-hidden="true" />
            <span className="skymark__tip" role="tooltip">
              <strong>{m.name}</strong>
              {m.detail && <span>{m.detail}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
