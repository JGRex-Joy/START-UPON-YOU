import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { renderToImageData, type RenderOptions } from '../../engines/imageProcessing';
import { pixelToSky, skyToPixel } from '../../services/fits/wcs';
import { formatDecDms, formatRaHms } from '../../utils/coords';
import type { Wcs } from '../../types';
import { fitView, niceStepDeg, type Marker, type MarkerKind, type ViewState } from './viewState';

export interface ViewerImage {
  data: Float32Array;
  width: number;
  height: number;
  wcs: Wcs | null;
}

interface Props {
  image: ViewerImage | null;
  render: RenderOptions;
  view: ViewState | null;
  onViewChange: (v: ViewState) => void;
  markers?: Marker[];
  onMarkerClick?: (m: Marker) => void;
  showGrid?: boolean;
  badge?: ReactNode;
  empty?: ReactNode;
  ariaLabel: string;
  /** Optional: reports the effective view and viewport size (used only to optionally sync Sky Context). */
  onViewport?: (v: ViewState, size: { w: number; h: number }) => void;
}

const MARKER_COLOR: Record<MarkerKind, string> = {
  candidate: '#BFD7F2', gaia: '#F2D9A6', wise: '#9FD3C7', mover: '#F4A261', target: '#F1F4F8',
};

function useSize(el: HTMLElement | null) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [el]);
  return size;
}

export function ImageViewer({ image, render, view, onViewChange, markers = [], onMarkerClick, showGrid = true, badge, empty, ariaLabel, onViewport }: Props) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const size = useSize(host);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ px: number; py: number; v: ViewState; moved: boolean } | null>(null);

  // Pre-render the image to an offscreen canvas only when data or display options change.
  const offscreen = useMemo(() => {
    if (!image) return null;
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(renderToImageData(image.data, image.width, image.height, render), 0, 0);
    return c;
  }, [image, render]);

  const v = useMemo(() => view ?? (image && size.w ? fitView(image, size.w, size.h) : null), [view, image, size.w, size.h]);

  useEffect(() => { if (v && size.w && onViewport) onViewport(v, { w: size.w, h: size.h }); }, [v, size.w, size.h, onViewport]);

  const toScreen = useCallback(
    (x: number, y: number) => (v ? { sx: size.w / 2 + (x - v.cx) * v.zoom, sy: size.h / 2 - (y - v.cy) * v.zoom } : { sx: 0, sy: 0 }),
    [v, size.w, size.h],
  );

  // ---- drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05090F';
    ctx.fillRect(0, 0, size.w, size.h);
    if (!image || !offscreen || !v) return;

    ctx.imageSmoothingEnabled = v.zoom < 1;
    const dx = size.w / 2 + (-0.5 - v.cx) * v.zoom;
    const dy = size.h / 2 - (image.height - 0.5 - v.cy) * v.zoom;
    ctx.drawImage(offscreen, dx, dy, image.width * v.zoom, image.height * v.zoom);

    if (showGrid && image.wcs) drawGrid(ctx, image, v, size.w, size.h);

    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    for (const m of markers) {
      const { sx, sy } = toScreen(m.x, m.y);
      if (sx < -20 || sy < -20 || sx > size.w + 20 || sy > size.h + 20) continue;
      drawMarker(ctx, m, sx, sy);
    }
  }, [image, offscreen, v, size.w, size.h, showGrid, markers, toScreen]);

  // ---- interaction
  const update = useCallback((nv: ViewState) => onViewChange(nv), [onViewChange]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !v || !image) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left - size.w / 2;
      const my = e.clientY - rect.top - size.h / 2;
      const f = Math.exp(-e.deltaY * 0.0015);
      const zoom = Math.min(80, Math.max(0.05, v.zoom * f));
      const k = zoom / v.zoom;
      // keep the pixel under the cursor fixed
      update({ zoom, cx: v.cx + (mx / v.zoom) * (1 - 1 / k), cy: v.cy - (my / v.zoom) * (1 - 1 / k) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [v, image, size.w, size.h, update]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!v) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, v, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (v && image) {
      setCursor({
        x: (e.clientX - rect.left - size.w / 2) / v.zoom + v.cx,
        y: -(e.clientY - rect.top - size.h / 2) / v.zoom + v.cy,
      });
    }
    const d = drag.current;
    if (!d) return;
    const dxp = e.clientX - d.px;
    const dyp = e.clientY - d.py;
    if (Math.abs(dxp) + Math.abs(dyp) > 3) d.moved = true;
    update({ ...d.v, cx: d.v.cx - dxp / d.v.zoom, cy: d.v.cy + dyp / d.v.zoom });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !onMarkerClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: Marker | null = null;
    let bd = 12 * 12;
    for (const m of markers) {
      const { sx, sy } = toScreen(m.x, m.y);
      const dd = (sx - px) ** 2 + (sy - py) ** 2;
      if (dd < bd) { bd = dd; best = m; }
    }
    if (best) onMarkerClick(best);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!v || !image) return;
    const step = 40 / v.zoom;
    if (e.key === 'ArrowLeft') update({ ...v, cx: v.cx - step });
    else if (e.key === 'ArrowRight') update({ ...v, cx: v.cx + step });
    else if (e.key === 'ArrowUp') update({ ...v, cy: v.cy + step });
    else if (e.key === 'ArrowDown') update({ ...v, cy: v.cy - step });
    else if (e.key === '+' || e.key === '=') update({ ...v, zoom: Math.min(80, v.zoom * 1.25) });
    else if (e.key === '-') update({ ...v, zoom: Math.max(0.05, v.zoom / 1.25) });
    else if (e.key === '0') update(fitView(image, size.w, size.h));
    else return;
    e.preventDefault();
  };

  const readout = useMemo(() => {
    if (!cursor || !image) return null;
    const xi = Math.round(cursor.x);
    const yi = Math.round(cursor.y);
    if (xi < 0 || yi < 0 || xi >= image.width || yi >= image.height) return null;
    const val = image.data[yi * image.width + xi];
    const sky = image.wcs ? pixelToSky(image.wcs, cursor.x, cursor.y) : null;
    return { xi, yi, val, sky };
  }, [cursor, image]);

  return (
    <div className="viewer" ref={setHost} tabIndex={0} onKeyDown={onKeyDown} role="application" aria-label={ariaLabel}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: drag.current ? 'grabbing' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={() => image && update(fitView(image, size.w, size.h))}
      />
      {!image && <div className="viewer__empty">{empty}</div>}
      {badge && <div className="viewer__badge">{badge}</div>}
      {image && (
        <div className="viewer__readout mono" aria-live="off">
          {readout ? (
            <>
              <span>x {readout.xi} · y {readout.yi}</span>
              <span>{Number.isFinite(readout.val) ? `value ${readout.val.toPrecision(4)}` : 'value — (missing)'}</span>
              {readout.sky && <span>{formatRaHms(readout.sky.ra)} {formatDecDms(readout.sky.dec)}</span>}
            </>
          ) : (
            <span className="dim">scroll to zoom · drag to pan · double-click to fit · arrows/+/−/0</span>
          )}
        </div>
      )}
    </div>
  );
}

function drawMarker(ctx: CanvasRenderingContext2D, m: Marker, sx: number, sy: number) {
  const c = MARKER_COLOR[m.kind];
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = m.selected ? 2 : 1.25;
  ctx.setLineDash([]);
  if (m.kind === 'candidate' || m.kind === 'mover') {
    const r = m.selected ? 11 : 8;
    if (m.kind === 'mover') ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (m.selected) { ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1; }
  } else if (m.kind === 'gaia') {
    ctx.beginPath();
    ctx.moveTo(sx, sy - 6); ctx.lineTo(sx + 6, sy); ctx.lineTo(sx, sy + 6); ctx.lineTo(sx - 6, sy); ctx.closePath();
    ctx.stroke();
  } else if (m.kind === 'wise') {
    ctx.strokeRect(sx - 6, sy - 6, 12, 12);
  } else {
    ctx.beginPath();
    ctx.moveTo(sx - 14, sy); ctx.lineTo(sx - 5, sy); ctx.moveTo(sx + 5, sy); ctx.lineTo(sx + 14, sy);
    ctx.moveTo(sx, sy - 14); ctx.lineTo(sx, sy - 5); ctx.moveTo(sx, sy + 5); ctx.lineTo(sx, sy + 14);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (m.label && (m.selected || m.kind === 'target')) {
    ctx.fillStyle = c;
    ctx.fillText(m.label, sx + 12, sy - 10);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, img: ViewerImage, v: ViewState, W: number, H: number) {
  const wcs = img.wcs;
  if (!wcs) return;
  const toWorld = (sx: number, sy: number) => pixelToSky(wcs, (sx - W / 2) / v.zoom + v.cx, -(sy - H / 2) / v.zoom + v.cy);
  const corners = [toWorld(0, 0), toWorld(W, 0), toWorld(0, H), toWorld(W, H), toWorld(W / 2, H / 2)];
  const ra0 = corners[4].ra;
  const unwrap = (ra: number) => ((((ra - ra0 + 540) % 360) + 360) % 360) - 180 + ra0;
  const ras = corners.map((c) => unwrap(c.ra));
  const decs = corners.map((c) => c.dec);
  const raMin = Math.min(...ras), raMax = Math.max(...ras);
  const decMin = Math.min(...decs), decMax = Math.max(...decs);
  const cosd = Math.max(0.05, Math.cos((corners[4].dec * Math.PI) / 180));
  const stepDec = niceStepDeg(decMax - decMin);
  const stepRa = niceStepDeg((raMax - raMin) * cosd) / cosd;
  const decimals = Math.max(0, Math.min(5, Math.ceil(-Math.log10(stepDec)) + 1));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(148,163,184,0.28)';
  ctx.fillStyle = 'rgba(190,205,225,0.75)';
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  const project = (ra: number, dec: number) => {
    const p = skyToPixel(wcs, ra, dec);
    return p ? { sx: W / 2 + (p.x - v.cx) * v.zoom, sy: H / 2 - (p.y - v.cy) * v.zoom } : null;
  };
  for (let ra = Math.ceil(raMin / stepRa) * stepRa; ra <= raMax; ra += stepRa) {
    ctx.beginPath();
    let first = true;
    for (let k = 0; k <= 24; k++) {
      const p = project(ra, decMin + ((decMax - decMin) * k) / 24);
      if (!p) continue;
      if (first) { ctx.moveTo(p.sx, p.sy); first = false; } else ctx.lineTo(p.sx, p.sy);
    }
    ctx.stroke();
    const lab = project(ra, decMin + (decMax - decMin) * 0.02);
    if (lab) ctx.fillText(`${(((ra % 360) + 360) % 360).toFixed(decimals + 1)}°`, Math.min(W - 60, Math.max(4, lab.sx + 3)), H - 6);
  }
  for (let dec = Math.ceil(decMin / stepDec) * stepDec; dec <= decMax; dec += stepDec) {
    ctx.beginPath();
    let first = true;
    for (let k = 0; k <= 24; k++) {
      const p = project(raMin + ((raMax - raMin) * k) / 24, dec);
      if (!p) continue;
      if (first) { ctx.moveTo(p.sx, p.sy); first = false; } else ctx.lineTo(p.sx, p.sy);
    }
    ctx.stroke();
    const lab = project(raMax - (raMax - raMin) * 0.02, dec);
    if (lab) ctx.fillText(`${dec.toFixed(decimals)}°`, 6, Math.min(H - 16, Math.max(12, lab.sy - 3)));
  }
  ctx.restore();
}
