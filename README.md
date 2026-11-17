# AdStreamX

Modular video player and (planned) interactive advertising platform.

> **Status — Phases 1–2 of 9 complete.**
> Phase 1: the player plays MP4, HLS VOD and HLS live with an accessible custom UI and recovers
> from network faults. Phase 2: typed SDK with seven controllers, plugin API, React wrapper,
> cross-origin iframe player with a secured postMessage protocol, embed code generator, signed
> operator commands and a consent-gated analytics client. 75 unit and 45 browser tests pass
> (Chrome 153).
> **Advertising, overlays, polls, the backend, admin dashboard and analytics reporting are not
> built yet.** Nothing here claims VAST/VMAP/SIMID/OMID support. See
> [`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md) and the
> [phase reports](reports/).

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

Full API, controllers, plugins, events and keyboard shortcuts: [`docs/player/API.md`](docs/player/API.md).

### As an iframe (cross-origin)

```html
<iframe id="player" src="https://player.example.com/embed/#cfg=…" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
<script src="https://player.example.com/sdk/adstreamx.js"></script>
<script>
  const embed = AdStreamX.connectIframe(document.getElementById('player'), { origin: 'https://player.example.com' });
  embed.ready().then(() => embed.play());
</script>
```

Generate the snippet with the Lab's **Embed code** panel or `AdStreamX.generateEmbedCode()`.
Protocol and security rules: [`docs/player/EMBED_PROTOCOL.md`](docs/player/EMBED_PROTOCOL.md).
Commands and permissions: [`docs/player/COMMANDS.md`](docs/player/COMMANDS.md).

### In React

```tsx
import { AdStreamXPlayer } from '@adstreamx/react-player';
<AdStreamXPlayer source={{ src: '/show/master.m3u8' }} config={{ branding: { title: 'Ep 1' } }} />
```

## Develop

```bash
pnpm install          # once registry access is available (see docs/BLOCKERS.md)
npm run link          # offline stand-in for workspace linking (TOOLCHAIN_DIR=… to link a local toolchain)
npm run build         # esbuild → SDK (IIFE + ESM) and Player Lab
npm run typecheck     # tsc, strict
npm run test:unit     # node:test, 75 tests, runs on plain Node (no install)
npm run test:e2e      # Playwright (Chrome channel), 45 tests, starts the fixture server itself
```

## Repository

```
apps/player-lab/          React Player Lab (diagnostics, presets, fault simulator, embed/analytics/command tools)
apps/embed-player/        iframe player page (/embed/)
packages/shared-types/    public types (config, state, events, errors, commands)
packages/player-core/     engine-agnostic lifecycle, recovery, live logic, config, probe
packages/playback-adapters/  engines (native HTML5 today; hls.js / Video.js 8 planned)
packages/player-controls/ accessible custom UI, keyboard + touch
packages/player-sdk/      AdStreamX.create(), controllers, plugins, IIFE/ESM bundles
packages/react-player/    React component wrapper
packages/embed-protocol/  postMessage protocol v1 (iframe server, host client), embed code generator
packages/command-protocol/ command schema, role permissions, Ed25519 verification
packages/analytics-sdk/   consent-gated analytics collector
infrastructure/fixtures/  zero-dependency media test server (live simulation, faults, signing)
infrastructure/scripts/   FFmpeg fixture generation, build, workspace linking
tests/unit, tests/e2e     node:test and Playwright suites
docs/                     architecture, ADRs, feature matrix, blockers, known issues
reports/                  phase reports with actual test results
```

Packages listed in the original plan (ad-engine, ima-adapter, overlay-engine, api, admin-dashboard, …)
are created when their phase starts — no empty placeholders. `types/react-shim.d.ts` is a temporary
stand-in for `@types/react` (docs/BLOCKERS.md B6).
