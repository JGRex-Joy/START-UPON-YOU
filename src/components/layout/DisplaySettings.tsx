import { useStore } from '../../app/store';
import type { ColormapKind, StretchKind } from '../../engines/imageProcessing';
import { Term } from './Term';

export function DisplaySettings() {
  const { state, actions } = useStore();
  const r = state.render;
  return (
    <div className="panelstack">
      <label className="select-labeled">
        <span><Term k="stretch">Stretch</Term></span>
        <select value={r.stretch} onChange={(e) => actions.patch({ render: { ...r, stretch: e.target.value as StretchKind } })}>
          <option value="asinh">asinh</option><option value="log">log</option><option value="sqrt">sqrt</option><option value="linear">linear</option>
        </select>
      </label>
      <label className="select-labeled">
        <span>Colour map</span>
        <select value={r.colormap} onChange={(e) => actions.patch({ render: { ...r, colormap: e.target.value as ColormapKind } })}>
          <option value="gray">greyscale</option><option value="heat">heat</option>
        </select>
      </label>
      <div className="field">
        <label htmlFor="hi">Upper clip <span className="mono">{(r.highPct * 100).toFixed(1)}%</span></label>
        <input id="hi" type="range" min={0.9} max={1} step={0.001} value={r.highPct} onChange={(e) => actions.patch({ render: { ...r, highPct: Number(e.target.value) } })} />
      </div>
      <label className="check"><input type="checkbox" checked={state.showGrid} onChange={(e) => actions.patch({ showGrid: e.target.checked })} /> RA/Dec grid <Term k="wcs">(from WCS)</Term></label>
    </div>
  );
}
