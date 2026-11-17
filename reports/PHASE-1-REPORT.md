# Phase 1 report — core player and Player Lab

Date: 2026-11-16 · Gate result: **PASSED in Chrome** (Firefox/WebKit/devices not run — B5)

## 1. Code changes
New repository (the target folder held an empty git repo). Monorepo with five packages, the
Player Lab app, a zero-dependency media/fixture server, FFmpeg fixture generation, unit and
browser test suites, and documentation. No prior code existed to preserve.

## 2. Files
| Area | Files |
|---|---|
| Types | `packages/shared-types/src/index.ts` |
| Core | `packages/player-core/src/{player,adapter,backoff,capabilities,config,emitter,errors,live,probe,source,index}.ts` |
| Engine | `packages/playback-adapters/src/{native,index}.ts` |
| UI | `packages/player-controls/src/{controls,keyboard,styles,icons,index}.ts` |
| SDK | `packages/player-sdk/src/{index,global}.ts` → `dist/adstreamx.js` (61.4 KiB min, 19.3 KiB gzip), `dist/adstreamx.esm.js` |
| Lab | `apps/player-lab/src/{main.tsx,presets.ts,index.html,lab.css,react-shim.d.ts}` → `dist/` |
| Infra | `infrastructure/fixtures/server.mjs` (+`.d.mts`), `infrastructure/fixtures/static/captions/*.vtt`, `infrastructure/scripts/{generate-fixtures.sh,patch-master.mjs,fixture-manifest.mjs,build.mjs,link-workspace.mjs}` |
| Tests | `tests/unit/{pure,player-core,probe-and-fixtures}.test.ts`, `tests/unit/helpers/fake-media.ts`, `tests/e2e/{playback,recovery,ui-and-lifecycle,autoplay-policy,lab}.spec.ts`, `tests/e2e/{helpers.ts,pages/harness.html}`, `playwright.config.ts` |
| Docs | `README.md`, `docs/{ARCHITECTURE,FEATURE_MATRIX,DEPENDENCIES,BLOCKERS,KNOWN_ISSUES,TESTING,IMPLEMENTATION_CHECKLIST}.md`, `docs/adr/0001–0005`, `docs/player/API.md` |
| Config | `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml` (not yet run) |

## 3. Implementation summary
- **PlayerCore**: token-guarded lifecycle (stale callbacks ignored), typed events, immutable
  state snapshots, config validation, origin allowlist, URL safety, bounded exponential
  backoff, stall and startup watchdogs, probe-based error classification, approved fallbacks,
  VOD position restore, live latency (real DVR maths or drift estimate), Go Live, catch-up,
  autoplay with muted fallback, fullscreen/PiP/theater, clean destroy.
- **Native engine** honest about limits (no levels/audio switching without browser APIs).
- **Controls**: dark responsive theme, accent branding, seek bar with buffer, live badge,
  menus (captions/audio/quality/speed) with ARIA radio items and focus return, focus-scoped
  keyboard shortcuts, touch gestures, auto-hide, screen-reader announcements, error panel.
- **Fixture server**: MIME/ranges/CORS/cache rules, wall-clock live HLS (TS + fMP4) with
  pinnable clock, HMAC path-token signing, canned failures, fault-injection API, request log.
- **Player Lab**: presets (VOD/live/recovery/errors), URL/mode/engine, load/unload/reset,
  state inspector, live diagnostics, quality/tracks info, fault simulator, event log with
  filter and diagnostics download, branding/recovery settings, responsive preview.

## 4. Tests executed
- `tsc -p tsconfig.json` (strict) — clean.
- Unit: `node --test "tests/unit/**/*.test.ts"` — 42 tests.
- E2E: `playwright test` (project `chrome`, Chrome for Testing 153.0.8010.12, headless,
  `retries: 0`) — 34 tests, run **3 consecutive times** on the final code.

## 5. Actual results
| Suite | Result |
|---|---|
| Typecheck | 0 errors |
| Unit | **42/42 passed** (3 of 3 runs) |
| E2E | **34/34 passed** in each of 3 consecutive runs (≈95 s per run); raw: `reports/phase1-e2e-results.json` |

Gate items:
| Gate item | Evidence |
|---|---|
| MP4 / HLS VOD / HLS Live play | `playback.spec` MP4, HLS VOD TS, HLS VOD fMP4, Live TS, Live fMP4 — playback progress asserted |
| Seeking | `VOD seeking` (seekTo, clamping, 15× play/pause/seek), keyboard seeks |
| Quality changes | automatic: native ABR observed reaching **1280×720**, reported as `qualitychange`; manual: correctly refused (engine limit) |
| Error recovery | transient 503s at start (retried, then plays); mid-VOD segment outage → `recovering` → resumes near position |
| Source switching | MP4→HLS→Live→MP4; 4 rapid `setSource` calls → last one wins, no stale error |
| Live-edge recovery | live segment outage → recovered at live edge (**4 retries** observed); pause → behind live → Go Live → edge |
| Cleanup | 40 create/destroy cycles: **+0.02 MB** heap after GC, 0 instances, 0 DOM nodes, 0 listeners; destroy mid-load and mid-play safe |
| Multiple instances | two players isolated (pause, volume, destroy) |

Measured: startup (load → first frame) on localhost 53–55 ms in the Lab; live latency estimate
≈1.9 s at join on the 12 s window fixture.

## 6. Defects found during the phase (fixed, with regression tests)
1. New load during a recovery inherited the `recovering` flag → wrong status (unit test).
2. Browser's `pause` on error cleared the play intent → recovery reloaded but never resumed (e2e).
3. Recovery into a paused state never cleared `recovering` (e2e).
4. Invalid config left an empty player root in the page (e2e).
5. `currentQuality` went stale after native ABR switches (e2e).
6. Native adapter called `load()` after setting `src`, starting two pipelines.
7. **Chromium 153 native-HLS bug** (`DEMUXER_ERROR_COULD_NOT_PARSE` when live `play()` comes
   ≥ ~150 ms after metadata) reproduced on a bare `<video>` and mitigated (KNOWN_ISSUES §1).

## 7. Remaining defects and limitations
- No DVR, manual quality, HLS subtitle/audio renditions on Chromium native; no HLS on Firefox —
  needs hls.js (blocked, B1/B2).
- Not run: Firefox, WebKit, Safari, iOS, Android, real screen readers (B5).
- No lockfile (B1); CI never executed (B8); no Docker (B4).
- Lab VAST/VMAP and overlay panels are labelled placeholders for Phases 3/4.
- Original reference article could not be fetched (B7).

## 8. Checklist
See `docs/IMPLEMENTATION_CHECKLIST.md` (updated). **Next:** unblock B1, add the hls.js engine and
rerun this gate in Chromium + Firefox; then React wrapper / iframe protocol (Phase 2); Phase 3
requires Video.js 8 + videojs-ima + IMA SDK access.
