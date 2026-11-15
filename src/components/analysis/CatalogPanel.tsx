import { useStore } from '../../app/store';
import { CATALOG_SERVICES } from '../../services/catalog';
import type { CatalogId } from '../../types';

const IDS: CatalogId[] = ['gaia-dr3', 'allwise'];

export function CatalogPanel() {
  const { state, actions } = useStore();
  return (
    <div className="catalogs">
      {IDS.map((id) => {
        const svc = CATALOG_SERVICES[id];
        const layer = state.catalogs[id];
        return (
          <div key={id} className="catalog">
            <label className="switch">
              <input type="checkbox" checked={layer.enabled} onChange={() => actions.toggleCatalog(id)} disabled={!state.dataset} />
              <span className={`switch__mark switch__mark--${id}`} aria-hidden="true" />
              <span className="switch__label">{svc.label}</span>
              <span className="mono dim catalog__status">
                {layer.enabled && layer.status === 'loading' && 'querying…'}
                {layer.enabled && layer.status === 'ready' && `${layer.sources.length} sources`}
                {layer.enabled && layer.status === 'error' && 'unavailable'}
              </span>
            </label>
            {layer.enabled && layer.status === 'error' && (
              <p className="notice notice--warn" role="alert">
                {layer.error}
                {state.dataset?.origin !== 'demo' && ' If this is a CORS/network block, route the service through a proxy: see src/config/hosts.ts and vite.config.ts.'}
              </p>
            )}
            <p className="catalog__caveat">{svc.caveat}</p>
          </div>
        );
      })}
      <p className="catalog__legend mono"><span className="lg lg--gaia">◇</span> Gaia &nbsp; <span className="lg lg--wise">□</span> WISE &nbsp; <span className="lg lg--target">⊹</span> target &nbsp; <span className="lg lg--cand">○</span> candidate</p>
    </div>
  );
}
