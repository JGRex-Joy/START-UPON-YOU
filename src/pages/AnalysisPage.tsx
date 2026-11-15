import { useState } from 'react';
import { useStore } from '../app/store';
import { EpochViewer } from '../components/sky/EpochViewer';
import { DetectionPanel } from '../components/analysis/DetectionPanel';
import { SubtractionTool } from '../components/analysis/SubtractionTool';
import { TrackingTool } from '../components/analysis/TrackingTool';
import { CatalogPanel } from '../components/analysis/CatalogPanel';
import { EpochSelect } from '../components/comparison/CompareView';
import { DisplaySettings } from '../components/layout/DisplaySettings';

type Tool = 'detect' | 'subtract' | 'track';
const TOOLS: { id: Tool; label: string; status: string; note: string }[] = [
  { id: 'detect', label: 'Source detection', status: 'prototype', note: 'Finds points of light above the background. Everything it returns is a candidate for you to check, not a measurement.' },
  { id: 'subtract', label: 'Image subtraction', status: 'prototype', note: 'Takes one observation away from another so that what changed is left. Frames are aligned by pixel grid only, so expect residuals.' },
  { id: 'track', label: 'Cross-epoch tracking', status: 'prototype', note: 'Follows the same source between observations, which is how motion is measured. You confirm the matches.' },
];

function DetectTool() {
  const { state, actions } = useStore();
  const epochs = state.dataset?.epochs ?? [];
  return (
    <div className="tool">
      <aside className="tool__side">
        <h2 className="tool__h">Source detection</h2>
        {epochs.length > 0 && <EpochSelect label="Epoch" value={state.epochIndex} onChange={actions.selectEpoch} epochs={epochs} />}
        <DetectionPanel epochIndex={state.epochIndex} />
        <details className="fold"><summary>Overlays &amp; display</summary><CatalogPanel /><DisplaySettings /></details>
      </aside>
      <div className="tool__stage"><div className="tool__viewer"><EpochViewer epochIndex={state.epochIndex} /></div></div>
    </div>
  );
}

export function AnalysisPage({ goExplorer }: { goExplorer: () => void }) {
  const { state } = useStore();
  const [tool, setTool] = useState<Tool>('detect');
  if (!state.dataset || state.dataset.epochs.length === 0) {
    return (
      <div className="page-empty">
        <h1 className="display">Analysis</h1>
        <p>{state.dataset
          ? 'The loaded product has no individual epochs to analyse (it is a spectral cube).'
          : state.target ? `${state.target.name} is selected, but its data has not been loaded yet. Analysis runs on the epochs of the loaded data.` : 'Load a position in the Explorer first. Analysis runs on the epochs of the loaded data.'}</p>
        <button className="btn btn--primary" onClick={goExplorer}>{state.target && !state.dataset ? `Load ${state.target.name}` : 'Go to Explorer'}</button>
      </div>
    );
  }
  return (
    <div className="analysis">
      <div className="analysis__tabs" role="tablist" aria-label="Analysis tool">
        {TOOLS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tool === t.id} className={`stage__tab ${tool === t.id ? 'is-active' : ''}`} onClick={() => setTool(t.id)}>
            {t.label} <span className="tag">{t.status}</span>
          </button>
        ))}
        {state.dataset.origin === 'demo' && <span className="badge badge--demo analysis__demo">Running on synthetic demonstration data</span>}
      </div>
      <p className="toolnote"><img src={`${import.meta.env.BASE_URL}nyan-cat.png`} alt="" /><span><b>{TOOLS.find((t) => t.id === tool)?.label}</b> — {TOOLS.find((t) => t.id === tool)?.note}</span></p>
      {tool === 'detect' && <DetectTool />}
      {tool === 'subtract' && <SubtractionTool />}
      {tool === 'track' && <TrackingTool />}
    </div>
  );
}
