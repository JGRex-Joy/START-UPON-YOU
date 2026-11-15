# AWS-first SPHEREx data access

## Architecture
```
UI (Explorer, Spectral, Time Machine, Analysis)
  → store.tsx
     ├─ All-Sky Cube:  AllSkyCubeSession (typed states) → loadAllSkyCubeTile → AllSkyProvider
     │                    aws-s3 (DEFAULT, anonymous)   |  irsa (optional, explicit)
     ├─ Level-2 pixels: loadEpochImage → aws/level2.loadLevel2Window (HTTP Range) ; IRSA cutout only if AWS is unreachable
     └─ Level-2 discovery (OPTIONAL, concurrent, never throws): IRSA SIA2 (cloud_access → S3 key) + IRSA TAP
  → existing FITS parser / WCS / SpectralCube adapter / engines (unchanged)
```
Files: `services/aws/{errors,s3,allSkyProvider,cubeCache,cubeSession,level2}.ts`, `services/fits/remote.ts` (Range/stream byte
sources, header-driven HDU hopping), `services/spherex/{provider,discovery}.ts`, edits in `allSkyCube.ts`, `index.ts`, `store.tsx`,
`ExplorerPage.tsx`, `config/hosts.ts` (+ `/proxy/s3spherex`), `types`.

## What is documented vs. what is verified
Documented (IRSA cloud-access + SPHEREx data-access/data-products pages, read 2026-11-14): bucket `nasa-irsa-spherex`, us-east-1,
prefixes `dr1`, `qr3`, `qr2`; All-Sky Cube `dr1/hips5_cube/hips_20261026/Norder5/Dir[N]/Npix[P]_cube.fits`; Level-2
`<release>/level2/<PlanningPeriod>/l2b-v<V>-<date>/<Detector>/level2_<ObsID>D<det>_spx_l2b-v<V>-<date>.fits`.
The AWS Open Data registry pages for DR1/QR3 were stated as "pending publish by AWS" on the IRSA page.
**Not documented:** how `Dir[N]` is derived from Npix. The code uses floor(Npix/10000)*10000 as a *candidate only*; it is verified by
HEAD and, if absent, the real layout is discovered by listing. **Bucket contents were NOT verified against the real bucket** (the
build sandbox's egress policy denies the S3 host). Run `npm run test:live` on a networked machine.

## Coordinate discovery without TAP — what is missing
Object keys carry no sky position and no footprint index/manifest is documented in the bucket. Therefore Level-2 *coordinate* search
cannot be done with AWS alone. Implemented: (a) discovery by Observation ID via bucket listing, (b) SIA2/TAP as optional discovery,
whose rows carry the S3 key so pixels never touch IRSA. Proposed AWS-only solution: a small static index built once offline
(planning period → pointing/footprint polygons from the headers' WCS, one JSON/Parquet per planning period, hosted next to the app or
requested from IRSA as `dr1/index/`), queried client-side with a point-in-polygon test. Also: All-Sky Cube needs *no* discovery
(coordinate → Npix is pure computation), which is why it is fully AWS-independent of IRSA APIs.

## Transfer & memory
Range requests are used when the server answers 206 (verified in mock only); otherwise a forward stream. Cube: ~107 MB IMAGE layer
(512×512×102 float32) is held once as an ArrayBuffer (no copy); planes are decoded lazily; blank-plane scan uses transient planes.
Level-2: only the needed rows (~0.5 MB) are read instead of ~70 MB. No download starts before `authorize()`; cap 512 MB;
local cache = browser Cache API, LRU of 2 tiles. Cancellation aborts in-flight requests.
**Unverified:** whether the bucket sends CORS headers for browser use. If not, serve `/proxy/s3spherex` (Vite dev proxy is configured;
production needs the same reverse-proxy rule).


## On-demand channels (default for the All-Sky Cube)

The viewer no longer downloads the ~107 MB IMAGE layer. `loadAllSkyCubeLazy` reads only the FITS headers (HDU hopping),
the SPECTRAL_CHANNELS table and one channel (~1 MB); channel *k* is the contiguous byte range
`image.dataOffset + k·W·H·|BITPIX|/8`, fetched with an HTTP Range request when the user opens it (neighbours are prefetched).
"Load all channels" fetches the rest in parallel (4 at a time). If the server ignores Range, the loader falls back to the full
download path (`authorization_required` rules unchanged). `AllSkyCubeSession.start(pos, { full: true })` forces the full download.

Limits: on-demand channels live in memory only (no persistent per-channel cache); the full-tile Cache API path applies to `full: true`.
The point spectrum for a target position (HPX → pixel) is not implemented; the trace is the centre of the tile.
Verified only against a synthetic mock S3 — not against the real bucket (egress to S3 is blocked in the build sandbox).
