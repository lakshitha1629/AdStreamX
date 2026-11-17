# AdStreamX

Modular video player and (planned) interactive advertising platform.

> **Status — Phase 1 of 9 complete (core player + Player Lab).**
> The SDK plays MP4, HLS VOD and HLS live with a custom accessible UI, recovers from network
> faults and is covered by 42 unit and 34 browser tests (all passing in Chrome 153).
> **Advertising, overlays, polls, backend, admin dashboard and analytics are not built yet.**
> Nothing in this repo claims VAST/VMAP/SIMID/OMID support. See
> [`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md) and
> [`reports/PHASE-1-REPORT.md`](reports/PHASE-1-REPORT.md).

## Try it (no install needed)

Requires Node.js ≥ 22.18 (for built-in TypeScript type stripping) and, to regenerate media,
FFmpeg with libx264.

```bash
npm run fixtures   # generate test media with FFmpeg (≈38 MB, gitignored) — skip if media/ exists
npm run serve      # fixture + media server on http://127.0.0.1:8080
```

Open **http://127.0.0.1:8080/lab/** — the Player Lab. Pick a preset (VOD, live, error cases),
press **Load**, and use the fault simulator to break the network while it plays.

The built SDK and Lab (`packages/player-sdk/dist`, `apps/player-lab/dist`) and the generated
media were delivered alongside the sources so this works without installing anything. They are
gitignored build outputs — regenerate with `npm run build` / `npm run fixtures`.

## Embed the player

```html
<div id="player"></div>
<script src="/sdk/adstreamx.js"></script>
<script>
  const player = AdStreamX.create('#player', {
    source: { src: 'https://cdn.example.com/show/master.m3u8' },
    fallbackSources: [{ src: 'https://backup.example.com/show/master.m3u8' }],
    allowedSourceOrigins: ['https://cdn.example.com', 'https://backup.example.com'],
    branding: { accentColor: '#22d3ee', title: 'Episode 1' },
  });
  player.on('error', (e) => console.warn(e.code, e.detail));
  await player.ready();
</script>
```

Full API, events and keyboard shortcuts: [`docs/player/API.md`](docs/player/API.md).

## Develop

```bash
pnpm install          # once registry access is available (see docs/BLOCKERS.md)
npm run link          # offline stand-in for workspace linking (TOOLCHAIN_DIR=… to link a local toolchain)
npm run build         # esbuild → SDK (IIFE + ESM) and Player Lab
npm run typecheck     # tsc, strict
npm run test:unit     # node:test, 42 tests, runs on plain Node (no install)
npm run test:e2e      # Playwright (Chrome channel), 34 tests, starts the fixture server itself
```

## Repository

```
apps/player-lab/          React Player Lab (diagnostics, presets, fault simulator)
packages/shared-types/    public types (config, state, events, errors)
packages/player-core/     engine-agnostic lifecycle, recovery, live logic, config, probe
packages/playback-adapters/  engines (native HTML5 today; hls.js / Video.js 8 planned)
packages/player-controls/ accessible custom UI, keyboard + touch
packages/player-sdk/      AdStreamX.create() facade, IIFE/ESM bundles
infrastructure/fixtures/  zero-dependency media test server (live simulation, faults, signing)
infrastructure/scripts/   FFmpeg fixture generation, build, workspace linking
tests/unit, tests/e2e     node:test and Playwright suites
docs/                     architecture, ADRs, feature matrix, blockers, known issues
reports/                  phase reports with actual test results
```

Packages listed in the original plan (ad-engine, ima-adapter, overlay-engine, api, admin-dashboard, …)
are created when their phase starts — no empty placeholders.
