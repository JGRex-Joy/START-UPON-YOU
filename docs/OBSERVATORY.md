# Observatory entry: the all-sky map

The app opens on `#/` (route `sky`): one Aladin Lite all-sky map (Aitoff, whole sky) with the five challenge targets,
a **Find by Coordinates** slide-out, and an **Object Inspector**. `#/about` is the former landing page.

## What was reused, what was added
| Need | Reused | Added |
| --- | --- | --- |
| Sky viewer | `components/sky/SkyContext.tsx` + `services/aladin.ts` (loader, provider verification) | optional props: `projection`, `markers`, `selection`, `onPick`, `flyTo`; `SkyMarkerLayer.tsx` (DOM markers placed with Aladin's `world2pix`) |
| Shared target | `state.target` in `app/store.tsx` (read by Explorer, Spectral, timeline, Analysis) | `selectTarget()` action (sets the target **without** any IRSA call), `makeTarget()` helper |
| Targets | `services/targets.ts` (five targets, cited coordinates) | `focus: 'motion' \| 'variability'` per target |
| Coordinate input | `components/navigation/CoordinateSearch.tsx`, `utils/coords.ts` | `allowHours` (RA in hours), `parseRaUnit()` |
| AWS data | `services/aws/allSkyProvider.ts` `resolveCubeKey()` | `services/aws/tileAvailability.ts` (one anonymous HEAD per selected tile) |
| Routing | `app/router.ts` hash router | `sky` route, `app/skyUrl.ts` (`#/sky?t=<id>` or `#/sky?ra=&dec=`) |

## Data honesty rules enforced in the UI
* Background imagery is labelled "Context survey (not SPHEREx)".
* The inspector shows only retrieved facts: tile number (computed), AWS existence/size/date (HEAD request), and — only after the
  Observatory has queried IRSA for that same target — the number and dates of exposures. Otherwise it says "Not retrieved yet".
* A clicked position is never given a name. Only the five featured targets are "recognised" objects (no all-sky catalogue is queried).
* No Missions / Journal / Field Guide exist: they appear in the navigation as disabled "soon" items; no "Start a Mission" action is shown.

## Tests
* `npm test` — includes `tests/sky.ts` (targets vs cited sexagesimal values, RA hours/degrees, URL round trips, tile availability with mocked S3).
* `tests/e2e/observatory.cjs` — real Chromium + real Aladin Lite. Needs Playwright (not a dependency): build, `npm run preview`, then
  `ALADIN_JS=<node_modules/aladin-lite/dist/aladin.js> TILE_JPG=<any jpeg> node tests/e2e/observatory.cjs`.
  HiPS tiles, S3 and IRSA are fixtures (`tests/e2e/harness.cjs`).
