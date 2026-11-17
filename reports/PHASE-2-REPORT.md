# Phase 2 report — SDK and controllers

Date: 2026-11-17 · Gate result: **PASSED in Chrome 153** (Firefox/WebKit/devices not run — B5)

## 1. Code changes
- **Controllers** on the player: `playback`, `config`, `ads`, `overlays`, `interactions`,
  `analytics`, `commands`.
- **Plugin API** (`player.use`) with engine slots for ads, overlays and interactions.
- **Full typed event map**: ads incl. quartiles, skip and error; overlays; polls; commands;
  announcements; analytics; plugins.
- **New packages**: `command-protocol` (schema, permissions, Ed25519), `analytics-sdk`
  (client collector), `embed-protocol` (iframe server, host client, embed code generator),
  `react-player` (React wrapper).
- **New app**: `embed-player` (the `/embed/` iframe page).
- **UI**: operator announcements as an accessible text banner.
- **Player Lab panels**: embed code, analytics, command console.
- **Fixture server**: extra origins (`FIXTURE_ALT_PORTS`), `/__analytics` test ingest,
  `frame-ancestors 'self'` on the Lab.

## 2. Files
| Area | Files |
|---|---|
| Types | `packages/shared-types/src/index.ts` (analytics/commands config, commands, ad/overlay/poll contracts, extension events) |
| Core | `packages/player-core/src/{config,errors,player}.ts` (new config sections, new error codes, `emitExtension`) |
| SDK | `packages/player-sdk/src/{index,controllers,engines,analytics,commands,embed-client}.ts` |
| Commands | `packages/command-protocol/src/{validate,signing,index}.ts` |
| Analytics | `packages/analytics-sdk/src/{collector,index}.ts` |
| Embed | `packages/embed-protocol/src/{protocol,server,client,codegen,index}.ts`, `apps/embed-player/src/{main.ts,index.html}` |
| React | `packages/react-player/src/{AdStreamXPlayer.tsx,index.ts}`, `types/react-shim.d.ts` (moved from the Lab, extended) |
| UI | `packages/player-controls/src/{controls,styles}.ts` (announcement banner) |
| Lab | `apps/player-lab/src/{main.tsx,panels.tsx,card.tsx,lab.css}` |
| Infra | `infrastructure/fixtures/server.mjs`, `infrastructure/scripts/build.mjs`, `playwright.config.ts`, `.gitignore`, `tsconfig.json` |
| Tests | `tests/unit/{commands,analytics,embed,embed-bridge}.test.ts`, `tests/e2e/phase2-{iframe,react,controllers}.spec.ts`, `tests/e2e/lab.spec.ts` (+1), `tests/e2e/react-app.tsx`, `tests/e2e/pages/{react,host}.html` |
| Docs | `docs/player/{API,EMBED_PROTOCOL,COMMANDS}.md`, `docs/analytics/EVENTS.md`, `docs/adr/0006–0008`, `docs/{ARCHITECTURE,FEATURE_MATRIX,IMPLEMENTATION_CHECKLIST,BLOCKERS,TESTING}.md`, `README.md` |

## 3. Implementation summary
- **Commands**: every command passes validate (strict schema, 8 KiB, version, time window)
  → role check → operator signature → idempotency → apply → ack/event.
  - Roles: viewer < host. Operator gets live-admin actions only; it can never
    pause/unmute/seek viewers.
  - Only *applied* ids are remembered, so forged commands cannot block genuine ones.
- **Signing**: Ed25519 over canonical JSON. The player holds public JWKs only, and the
  embed config rejects private keys.
- **Iframe protocol v1**:
  - Exact-origin allowlist; an empty list means no control.
  - Every message is checked for source window, channel, envelope schema, 16 KiB size and
    50/s rate per origin.
  - Responses and events always go to a specific `targetOrigin`, never `*`.
  - Untrusted origins get `{ trusted: false }` only.
  - Config travels in the URL fragment.
- **Analytics client**:
  - Off by default and consent-gated: nothing is queued before consent, and revoking
    consent discards unsent events.
  - Batches, retries with the same event ids, uses a beacon on hide/destroy, bounded
    queue, session sampling.
  - Ad milestones are deduplicated per break + ad.
  - URLs lose query strings and token-like path segments.
- **React wrapper**: exactly one player per mount under StrictMode. Value-compared `source`
  and `config` props update the existing instance. Handler props are read through a ref.
  Full cleanup on unmount.
- **Embed code generator**: iframe, iframe control, script and React snippets. Inputs are
  validated (https, exact origins, config) and escaped per context (attribute, inline JSON,
  JS string).

## 4. Tests executed
- `tsc -p tsconfig.json` (strict).
- Unit: `node --test "tests/unit/**/*.test.ts"` — 75 tests in 7 files.
- E2E: `playwright test` (Chrome for Testing 153, `retries: 0`) — 45 tests (all Phase 1 tests
  plus 11 new), **3 consecutive full runs**.

## 5. Actual results
| Suite | Result |
|---|---|
| Typecheck | 0 errors |
| Unit | **75/75** — pure 15, player-core 18, probe/fixtures 9, commands 11, analytics 10, embed 6, embed-bridge 6 |
| E2E | **45/45 in each of 3 consecutive runs** (≈2.1 min/run, 0 flaky). Raw: `reports/phase2-e2e-results.json` |

Phase 2 evidence:
| Requirement | Test |
|---|---|
| Typed API + controllers | `controllers expose the documented surface` |
| Ad/overlay/poll events + plugins | `plugins: an engine fills the ads controller…` (events in order, impressions deduplicated, core events cannot be forged) |
| React wrapper lifecycle | `React wrapper: StrictMode-safe lifecycle…` (1 instance under StrictMode, prop updates on the same instance, handler swap, unmount → 0, 10 remount cycles → 1) |
| Iframe protocol, origin validation | `trusted cross-origin host controls…`, `untrusted origin cannot read or control…`, `several embeds… isolated by channel`, `embed page refuses invalid configuration…` |
| No wildcard for privileged messages | unit `embed-bridge`: every outgoing message from both sides uses an exact `targetOrigin`; `connectIframe` refuses `*` |
| Host vs viewer vs operator | `commands: viewer/host/operator permissions…`, iframe test (host cannot announce; forged operator → UNVERIFIED; signed → shown; signed pause → FORBIDDEN; replay → duplicate) |
| Embed generator | unit `embed code generator…` (escaping, validation); Lab test opens the generated iframe URL and the player boots |
| Analytics client | `analytics: off by default, consent-gated…` (no events before consent, batches + beacon reach ingest, 0 duplicates, signature and expiry never sent) |

Bundle sizes: SDK 93.9 KiB min / 29.8 KiB gzip (Phase 1: 61.4 / 19.3), embed page 98.5 KiB
min / 31.2 KiB gzip.

## 6. Defects found and fixed during the phase
1. `isExactOrigin` accepted `https://*.site.example`, because `*` is a legal host character
   for the URL parser (unit test).
2. Analytics never recorded `session_start` for the initial source: the core starts loading
   before the controller subscribes (found in e2e).
3. Path-token signed URLs (`/signed/<exp>/<sig>/…`) would have leaked their signature into
   analytics; token-like path segments are now redacted (e2e asserts the real signature
   never reaches ingest).
4. Remembering *rejected* command ids would have let a forged command block the genuine one;
   only applied ids are remembered now (unit test).

## 7. Remaining defects and limitations
- Ads/overlays/polls controllers have no engines until Phases 3–5 (`FEATURE_UNAVAILABLE`).
- Embed config is host-supplied in the URL fragment. Production configs, allowlists and
  `frame-ancestors` move server-side in Phase 6 (ADR-0007).
- Analytics server ingest, aggregation, retention and reports are Phase 8; only the client
  and a test endpoint exist.
- Ed25519 verification is proven in Chrome 153 and Node 22 only. It fails closed elsewhere.
- SDK bundle grew about 50%. Lazy-loading embed/analytics code is in the backlog.
- Carried over: no registry access (B1), no hls.js (B2), no Video.js/IMA (B3), no Docker (B4),
  Chromium-only e2e (B5), React type shim (B6).

## 8. Checklist
`docs/IMPLEMENTATION_CHECKLIST.md` updated: Phase 2 complete.

**Next:** Phase 3 (advertising engine). It needs registry access for Video.js 8 +
videojs-contrib-ads + videojs-ima, plus network access to `imasdk.googleapis.com`. The
house-ad adapter, mock adapter, ad state machine, scheduler and VAST fixtures can be built
before that; IMA itself cannot.
