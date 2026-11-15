# STARS UPON YOU.

*Look beyond what meets the eye.* — an in-browser explorer for NASA **SPHEREx** infrared observations
(React + TypeScript + Vite, Canvas, Web Workers, Aladin Lite for *context* surveys). No backend.

## Run

```bash
npm install
npm run dev        # http://localhost:5173  (dev server proxies IRSA / VizieR / Sesame for CORS)
npm test           # engine tests + AWS-route tests (synthetic mock S3)
npm run test:live  # REAL bucket checks (needs internet; exit 2 = unreachable, nothing verified)
npm run build      # typecheck + production build
npm run preview
```

Production hosting (Vercel: `vercel.json`, Netlify: `public/_redirects` already contain the proxy rules; without them every archive lookup 404s): serve `dist/` statically and add reverse-proxy rules for the prefixes in
`src/config/hosts.ts` (`/proxy/irsa`, `/proxy/vizier`, `/proxy/cds`) if the archives block direct browser requests.

## How the data model works (important)
* One SPHEREx file = **one exposure** on one of 6 detectors. Pixels sample different wavelengths (LVF).
* **Epochs** (time) and the **102 spectral channels** are independent. Channels are never used as dates.
* The timeline lists only epochs IRSA returns for the position; <2 epochs is reported as insufficient coverage.
* Observation time comes from `spherex.plane.time_bounds_lower`, never from the FITS `DATE` (file creation).
* Missing values stay `NaN` and are ignored by every engine — never treated as 0.

## Workflow
Sky Map → Explorer → **Observatory Submission** → Research Journal. Analysis is an optional step between Explorer and Submission (nothing in Submission requires it; results from it are carried over if used).
The Explorer's Image tab never shows channel controls; they exist only on the Spectral tab. When discovery returns no observations (or fails), Image says which, with the exact upstream error.
Browser flow checks: `tests/e2e/explorer_flows.cjs` (fixtures for IRSA/S3 only).

## Status

| Area | Status |
|---|---|
| Landing, Explorer layout, coordinate parsing/validation (deg, hms/dms) | Functional (browser-tested) |
| Image viewer: zoom/pan, WCS grid, stretch, metadata/provenance, local FITS open | Functional |
| FITS parser + WCS (TAN) | Functional (unit-tested) |
| Labelled synthetic demo (6 epochs, 102-slice cube) | Functional; always badged SYNTHETIC |
| Timeline, play/pause/speed, compare (sync zoom/pan, h/v layouts) | Functional on demo data |
| Spectral channel selector 1–102 | Functional on demo data; real wavelengths only when the product supplies them |
| Real SPHEREx DR1 All-Sky Cube tile (Spectral tab → “Find DR1 All-Sky Cube tile … on AWS”) | **AWS S3 is the primary source** (see `docs/AWS_MIGRATION.md`): Npix → verified key in `nasa-irsa-spherex` → size shown, user confirms → IMAGE layer + channel table via HTTP Range (stream fallback) → local cache. No IRSA API needed. Logic tested against a **synthetic mock S3**; **not yet verified against the real bucket** (`npm run test:live`). |
| Source detection (T = μ + kσ, worker) | Prototype, tested |
| Image subtraction (diverging scale, median bg, integer registration, noise gate) | Prototype — **not** calibrated difference imaging |
| Cross-epoch matching (movers / variables) | Prototype — "potential" flags only |
| **Live IRSA SPHEREx retrieval** (TAP + cutouts) | **Written from IRSA's documented formats; not exercised against the live archive** (built offline). Treat first online run as the integration test. |
| Gaia DR3 / WISE overlays (VizieR TAP) | Service abstraction implemented; needs network/proxy to verify |
| Aladin Lite context survey | Background HiPS is verified at runtime (`/properties`) and tried in order: ESA Sky (`skies.esac.esa.int`) → ESA CDN / NASA-IPAC IRSA mirror / CDS (per survey, see `SURVEY_PROVIDERS` in `src/services/aladin.ts`). If none is reachable a friendly message is shown. Context imagery only — **not SPHEREx**. Rendering with the real Aladin Lite build was not testable offline. |
| Nyan Cat (nav, empty states, discovery toast, easter egg) | Functional, uses the supplied sprite |

## Scientific limits
Detections are *candidates*. Subtraction has no PSF matching, flux scaling or flat-field calibration. Overlaying Gaia/WISE is
positional only, not cross-mission photometry. Target coordinates and their sources are listed in `src/services/targets.ts`
(WISE 0855 uses the supplied coordinates; Epsilon Indi B is low precision — refine with Gaia/SIMBAD).

## Layout
`src/{app,components,pages,services,engines,workers,hooks,types,utils,styles}` — engines are pure TypeScript and run in
`src/workers/analysis.worker.ts` (with a main-thread fallback).
