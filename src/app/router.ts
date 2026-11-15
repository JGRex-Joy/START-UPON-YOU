import { useCallback, useEffect, useState } from 'react';

export type Route = 'sky' | 'landing' | 'explorer' | 'analysis' | 'missions' | 'submit' | 'journal';

/** `#/` and `#/sky` are the Observatory sky map (the entry screen); `#/about` is the introduction page. */
export function parseRoute(hash: string): Route {
  const p = hash.replace(/^#\/?/, '').split('?')[0];
  if (p.startsWith('explorer')) return 'explorer';
  if (p.startsWith('analysis')) return 'analysis';
  if (p.startsWith('about')) return 'landing';
  if (p.startsWith('missions')) return 'missions';
  if (p.startsWith('submit')) return 'submit';
  if (p.startsWith('journal')) return 'journal';
  return 'sky';
}

/** Tiny hash router — keeps the prototype dependency-free and deployable as static files. */
export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((r: Route) => {
    window.location.hash = r === 'sky' ? '#/' : r === 'landing' ? '#/about' : `#/${r}`;
  }, []);
  return [route, go];
}
