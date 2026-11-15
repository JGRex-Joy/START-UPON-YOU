/**
 * First-run entry experience: the welcome scene and the states it moves through.
 *
 *   welcome_flying  Nyan Cat crosses the quiet universe (Scene 1)
 *   welcome_dialogue  it has settled at the centre and speaks; the START EXPLORING button follows (Scene 2)
 *   entering_universe  dialogue and button leave, the cat flies off, the welcome fades into the map (Scene 3)
 *   exploring        the sky map is the whole experience (Scene 4)
 *
 * Everything here is pure except the three localStorage helpers, so the sequencing is unit-testable.
 */
import { parseRoute } from './router';
import { parseSkyHash } from './skyUrl';

export type EntryPhase =
  | 'welcome_flying' | 'welcome_dialogue' | 'entering_universe'
  | 'sky_map_intro' | 'sky_pick' | 'sky_open'
  | 'exploring'            // the sky map, free to use
  | 'explorer_intro' | 'explorer_image' | 'explorer_compare' | 'explorer_spectral' | 'explorer_sky_context'
  | 'analysis_intro' | 'analysis_detect' | 'analysis_subtract' | 'analysis_track'
  | 'submission_nav' | 'submission_intro' | 'journal_nav' | 'journal_intro'
  | 'onboarding_complete';

export type TourRoute = 'sky' | 'explorer' | 'analysis' | 'submit' | 'journal';

export interface TourStep {
  phase: EntryPhase;
  /** The page this step happens on. */
  route: TourRoute;
  /** The real element to spotlight (omit to leave the whole page clear, e.g. the sky map). */
  selector?: string;
  text: string;
  /**
   * What the user must actually do to move on. Detected from real DOM events on real elements — never simulated.
   *   click  a click on `selector`      move  dragging or zooming the sky map      input  typing into `selector`
   * Steps without `act` just have a NEXT button.
   */
  act?: 'click' | 'move' | 'input';
  /** Shown if the user has not acted after a while. */
  hint?: string;
  next?: string;
}

const TAB = (n: number) => `.stage__tabs .stage__tab:nth-of-type(${n})`;
const TOOL = (n: number) => `.analysis__tabs .stage__tab:nth-of-type(${n})`;
const NAV = (r: string) => `.nav__link[data-route="${r}"]`;

/**
 * The action-based tutorial: CAT EXPLAINS -> USER ACTS -> APP DETECTS -> CAT RESPONDS -> NEXT STEP.
 * Every selector is an element the application really renders; every tool named here really exists.
 */
export const TOUR: TourStep[] = [
  { phase: 'sky_map_intro', route: 'sky', act: 'move',
    text: "Let's explore the universe! Drag the sky map to rotate it, scroll to zoom in, and look around.",
    hint: 'Hint: click and drag anywhere on the sky, or use the scroll wheel.' },
  { phase: 'sky_pick', route: 'sky', act: 'click', selector: '.skymark',
    text: 'Nice! Now choose one of the highlighted objects: click any marker on the map.',
    hint: 'Hint: the markers are the small diamonds and circles. Zoom out if you cannot see one.' },
  { phase: 'sky_open', route: 'sky', act: 'click', selector: '[data-testid="inspector-explore"]',
    text: "Great choice! Let's take a closer look. Press Start Investigation.",
    hint: 'Hint: the button is at the bottom of the panel that just opened.' },
  { phase: 'explorer_image', route: 'explorer', act: 'click', selector: TAB(1),
    text: "This is your Explorer. Let's inspect what SPHEREx observed here: Image shows the actual observations, one at a time. Open Image.",
    hint: 'Hint: click the highlighted Image tab.' },
  { phase: 'explorer_compare', route: 'explorer', act: 'click', selector: TAB(2),
    text: 'Compare puts two observations side by side, labelled with the dates recorded for each, so you can spot what changed. Open Compare.',
    hint: 'Hint: click the highlighted Compare tab.' },
  { phase: 'explorer_spectral', route: 'explorer', act: 'click', selector: TAB(3),
    text: 'Every object has a story written in light. Spectral lets you explore the light across different wavelengths. Open Spectral.',
    hint: 'Hint: click the highlighted Spectral tab.' },
  { phase: 'explorer_sky_context', route: 'explorer', act: 'click', selector: TAB(4),
    text: "Sky Context shows what's around your target in other surveys and catalogues. Open Sky Context.",
    hint: 'Hint: click the highlighted Sky context tab.' },
  { phase: 'analysis_intro', route: 'explorer', act: 'click', selector: NAV('analysis'),
    text: "That's your Explorer! Now let's investigate what we've found. Open Analysis in the top bar.",
    hint: 'Hint: Analysis is step 4 in the navigation at the top.' },
  { phase: 'analysis_detect', route: 'analysis', act: 'click', selector: TOOL(1),
    text: 'Welcome to Analysis! Source detection (a prototype) looks for points of light above the background. Treat what it finds as candidates. Open Source detection.',
    hint: 'Hint: click the highlighted tool tab.' },
  { phase: 'analysis_subtract', route: 'analysis', act: 'click', selector: TOOL(2),
    text: 'Image subtraction (a prototype) takes one observation away from another, so what is left is what changed. Open Image subtraction.',
    hint: 'Hint: click the highlighted tool tab.' },
  { phase: 'analysis_track', route: 'analysis', act: 'click', selector: TOOL(3),
    text: 'Cross-epoch tracking (a prototype) follows the same source between observations: that is how motion is measured. Open Cross-epoch tracking.',
    hint: 'Hint: click the highlighted tool tab.' },
  { phase: 'submission_nav', route: 'analysis', act: 'click', selector: NAV('submit'),
    text: 'When you have looked at the evidence, you write it up. Open Submission in the top bar.',
    hint: 'Hint: Submission is step 5 in the navigation at the top.' },
  { phase: 'submission_intro', route: 'submit', act: 'input', selector: '.subform input',
    text: 'This is your research log: question, what you saw, what you conclude. Try it: type a title for your investigation.',
    hint: 'Hint: click the Title field and type anything. You can change it later.' },
  { phase: 'journal_nav', route: 'submit', act: 'click', selector: NAV('journal'),
    text: 'When the log is complete, SUBMIT TO RESEARCH JOURNAL saves it. Now open Journal in the top bar to see where it goes.',
    hint: 'Hint: Journal is step 6 in the navigation at the top.' },
  { phase: 'journal_intro', route: 'journal', selector: '.research__head',
    text: 'This is your Research Journal. Every investigation you submit appears here, saved in this browser.', next: 'Next' },
];

export const TOUR_TEXT = {
  skyIntro: 'This is the sky map — your way in. The five markers are our challenge targets; click one, or anywhere else, to see what has been observed there.',
  skyNext: 'Ready to explore a little deeper? This is your Explorer.',
  explorerIntro: 'Ready to explore a little deeper? This is your Explorer.',
  analysisIntro: 'Welcome to Analysis! This is where exploration turns into investigation.',
  done: 'You\'re ready! The universe is yours to explore.',
  doneButton: 'START EXPLORING',
} as const;

export function tourStep(phase: EntryPhase): TourStep | undefined {
  return TOUR.find((s) => s.phase === phase);
}

/** Phases that run on top of a real application page rather than the welcome overlay. */
export function tourRoute(phase: EntryPhase): TourRoute | null {
  return tourStep(phase)?.route ?? null;
}

/** True for every step of the guided tutorial, including its closing message. */
export function isTourPhase(phase: EntryPhase): boolean {
  return !!tourStep(phase) || phase === 'onboarding_complete';
}

/** Exact wording from the brief. Both strings are asserted in tests so they cannot drift. */
export const WELCOME_DIALOGUE = "Oh, here you are. I've been waiting. Finally, someone curious. Let's start?";
export const WELCOME_BUTTON = 'START EXPLORING';
export const COMPANION_GREETING = 'Feel free. Explore what you like.';

/** Milliseconds. `calm` replaces the flight for people who ask for reduced motion. */
export const ENTRY_TIMING = {
  legMin: 230,
  legMax: 520,
  dash: 280,
  brake: 300,
  typePerChar: 32,
  buttonDelay: 400,
  exit: 900,
  greeting: 5200,
  skyHint: 9000,
  calmSettle: 420,
} as const;

/** How long the welcome runs before the button can be pressed (used by tests and to size the skip hint). */
export function welcomeDurationMs(reducedMotion: boolean, dialogueLength = WELCOME_DIALOGUE.length): number {
  const t = ENTRY_TIMING;
  const flight = reducedMotion ? t.calmSettle : 9 * ((t.legMin + t.legMax) / 2) + t.dash + t.brake;
  const typing = reducedMotion ? 0 : dialogueLength * t.typePerChar;
  return flight + typing + t.buttonDelay;
}

const KEY = 'suy.entry.seen.v3';
const TOUR_KEY = 'suy.tour.done.v3';

export function hasEnteredBefore(): boolean {
  try { return window.localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function rememberEntered(): void {
  try { window.localStorage.setItem(KEY, '1'); } catch { /* private mode: the welcome simply plays again */ }
}
export function hasFinishedTour(): boolean {
  try { return window.localStorage.getItem(TOUR_KEY) === '1'; } catch { return false; }
}
export function rememberTourFinished(): void {
  try { window.localStorage.setItem(TOUR_KEY, '1'); } catch { /* ignore */ }
}

export function forgetEntered(): void {
  try { window.localStorage.removeItem(KEY); window.localStorage.removeItem(TOUR_KEY); } catch { /* ignore */ }
}

/**
 * The welcome is for someone arriving at the sky map with nothing else asked for. A deep link (`#/sky?t=…`), another
 * route, or a previous visit all go straight to the application — an intro must never sit between a link and its target.
 */
export function initialEntryPhase({ hash, seen }: { hash: string; seen: boolean }): EntryPhase {
  if (parseRoute(hash) !== 'sky') return 'exploring';
  if (parseSkyHash(hash).kind !== 'none') return 'exploring';
  return seen ? 'exploring' : 'welcome_flying';
}

const ORDER: EntryPhase[] = ['welcome_flying', 'welcome_dialogue', 'entering_universe', ...TOUR.map((t) => t.phase), 'onboarding_complete'];

/** The sequence only ever moves forward, one step at a time. */
export function nextEntryPhase(phase: EntryPhase): EntryPhase {
  return ORDER[Math.min(ORDER.indexOf(phase) + 1, ORDER.length - 1)];
}

/** True while the full-screen welcome overlay is up (Scenes 1–3). */
export function isWelcomePhase(phase: EntryPhase): boolean {
  return phase === 'welcome_flying' || phase === 'welcome_dialogue' || phase === 'entering_universe';
}
