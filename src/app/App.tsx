import { useCallback, useEffect, useRef, useState } from 'react';
import { StoreProvider, useStore } from './store';
import { useRoute } from './router';
import { initialEntryPhase, hasEnteredBefore, hasFinishedTour, isWelcomePhase, nextEntryPhase, rememberEntered, rememberTourFinished, tourRoute, tourStep, isTourPhase, type EntryPhase } from './entry';
import { TourOverlay } from '../components/onboarding/TourOverlay';
import { primeAudio } from '../components/welcome/typewriter';
import { AppNav } from '../components/layout/AppNav';
import { WelcomeScene } from '../components/welcome/WelcomeScene';
import { SkyPage } from '../pages/SkyPage';
import { LandingPage } from '../pages/LandingPage';
import { ExplorerPage } from '../pages/ExplorerPage';
import { AnalysisPage } from '../pages/AnalysisPage';
import { JournalPage, MissionsPage, SubmissionPage } from '../pages/ResearchPages';
import { NyanFlight, NyanToast, useNyanEasterEgg } from '../components/mascot/NyanCat';
import { useReducedMotion } from '../utils/motion';

// A new visitor always starts the guided onboarding from the sky map, whatever link they arrived on.
// (Runs before the router reads the hash.)
if (typeof window !== 'undefined' && !hasFinishedTour() && window.location.hash !== '' && window.location.hash !== '#/') {
  window.history.replaceState(null, '', '#/');
}

function Shell() {
  const [route, go] = useRoute();
  const { state } = useStore();
  const egg = useNyanEasterEgg();
  const [done, setDone] = useState(0);
  const flying = egg.flights > done;
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<EntryPhase>(() => {
    if (!hasFinishedTour()) return 'welcome_flying';
    return initialEntryPhase({ hash: window.location.hash, seen: hasEnteredBefore() });
  });
  const body = useRef<HTMLDivElement | null>(null);
  const welcome = isWelcomePhase(phase) && route === 'sky';
  const [tourDone, setTourDone] = useState(hasFinishedTour);
  const onTour = !tourDone && isTourPhase(phase);

  const advance = useCallback((next: EntryPhase) => {
    if (next === 'entering_universe') { rememberEntered(); primeAudio(); }
    // Straight from the welcome into the guided tour of the sky map, unless it has already been completed.
    setPhase(next === 'exploring' && !hasFinishedTour() ? 'sky_map_intro' : next);
  }, []);

  const finishTour = useCallback(() => { rememberTourFinished(); setTourDone(true); go('missions'); }, [go]);
  const nextStep = useCallback(() => {
    setPhase((p) => {
      if (p === 'onboarding_complete') { finishTour(); return p; }
      const n = nextEntryPhase(p);
      // 'exploring' is free exploration, which is unlocked only at the end: the tour steps over it.
      return n;
    });
  }, [finishTour]);

  // The tour runs on the real pages: move the application to the page the current step belongs to.
  useEffect(() => {
    if (tourDone) return;
    const want = tourRoute(phase);
    if (want && route !== want) go(want);
  }, [phase, route, tourDone, go]);

  // Any gesture is a chance to unlock audio for the typewriter; browsers require one.
  useEffect(() => {
    const on = () => primeAudio();
    window.addEventListener('pointerdown', on, { once: true });
    window.addEventListener('keydown', on, { once: true });
    return () => { window.removeEventListener('pointerdown', on); window.removeEventListener('keydown', on); };
  }, []);

  // While the welcome is up the application underneath is real and already loading, but must not be reachable.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    if (welcome) el.setAttribute('inert', ''); else el.removeAttribute('inert');
  }, [welcome]);

  // The sky map is the only screen without the application header: it is meant to be nothing but sky.
  const bare = false;

  return (
    <div className={`app app--${route} ${bare ? 'app--bare' : ''}`}>
      {!welcome && <AppNav route={route} go={go} onLogoBurst={egg.fire} locked={onTour} allow={onTour ? (/data-route="(\w+)"/.exec(tourStep(phase)?.selector ?? '')?.[1] ?? null) : null} />}
      <div className="app__body" ref={body}>
        {route === 'sky' && (
          <SkyPage
            goExplorer={() => go('explorer')} goAbout={() => go('landing')} goAnalysis={() => go('analysis')}
            entered={phase === 'exploring' || tourDone} reducedMotion={reducedMotion}
            onReplayIntro={() => { setTourDone(false); setPhase('welcome_flying'); }}
            offerTour={false}
            onStartTour={() => setPhase('explorer_intro')}
          />
        )}
        {route === 'landing' && <LandingPage onExplore={() => go('explorer')} />}
        {route === 'explorer' && <ExplorerPage goAnalysis={() => go('analysis')} />}
        {route === 'analysis' && <AnalysisPage goExplorer={() => go('explorer')} />}
        {route === 'missions' && <MissionsPage go={go} />}
        {route === 'submit' && <SubmissionPage go={go} />}
        {route === 'journal' && <JournalPage go={go} />}
      </div>
      {welcome && <WelcomeScene phase={phase} onAdvance={advance} reducedMotion={reducedMotion} />}
      {onTour && !welcome && <TourOverlay phase={phase} onNext={nextStep} reducedMotion={reducedMotion} />}
      {flying && <NyanFlight key={egg.flights} onDone={() => setDone(egg.flights)} />}
      <NyanToast trigger={state.lastDiscovery} message="Candidate sources found — unverified, worth a closer look." />
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
