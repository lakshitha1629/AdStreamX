#!/usr/bin/env node
// Builds browser bundles with esbuild:
//   packages/player-sdk/dist/adstreamx.js       IIFE  (window.AdStreamX)
//   packages/player-sdk/dist/adstreamx.esm.js   ESM
//   apps/player-lab/dist/                       Player Lab (React)
//   apps/embed-player/dist/                     iframe player page
//   tests/e2e/pages/build/                      e2e-only bundles (React wrapper test app)
// Usage: node infrastructure/scripts/build.mjs [--watch]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  sourcemap: true,
  target: ['chrome100', 'firefox100', 'safari15'],
  logLevel: 'info',
  legalComments: 'none',
};

const sdkDir = path.join(root, 'packages/player-sdk/dist');
const labDir = path.join(root, 'apps/player-lab/dist');
const embedDir = path.join(root, 'apps/embed-player/dist');
const testDir = path.join(root, 'tests/e2e/pages/build');
for (const d of [sdkDir, labDir, embedDir, testDir]) fs.mkdirSync(d, { recursive: true });

const builds = [
  { ...common, entryPoints: [path.join(root, 'packages/player-sdk/src/global.ts')], outfile: path.join(sdkDir, 'adstreamx.js'), format: 'iife', minify: true },
  { ...common, entryPoints: [path.join(root, 'packages/player-sdk/src/index.ts')], outfile: path.join(sdkDir, 'adstreamx.esm.js'), format: 'esm', minify: true },
  {
    ...common,
    entryPoints: [path.join(root, 'apps/player-lab/src/main.tsx')],
    outfile: path.join(labDir, 'lab.js'),
    format: 'esm',
    minify: !watch,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  },
  {
    ...common,
    entryPoints: [path.join(root, 'apps/embed-player/src/main.ts')],
    outfile: path.join(embedDir, 'embed.js'),
    format: 'esm',
    minify: true,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'tests/e2e/react-app.tsx')],
    outfile: path.join(testDir, 'react-app.js'),
    format: 'esm',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, // dev build: StrictMode double-mount is exercised
  },
];

for (const [dir, out, files] of [
  ['apps/player-lab/src', labDir, ['index.html', 'lab.css']],
  ['apps/embed-player/src', embedDir, ['index.html']],
]) {
  for (const f of files) {
    const src = path.join(root, dir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
  }
}

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('[build] watching…');
} else {
  const results = await Promise.all(builds.map((b) => esbuild.build({ ...b, metafile: true })));
  for (const r of results) {
    for (const [file, meta] of Object.entries(r.metafile.outputs)) {
      if (file.endsWith('.map')) continue;
      console.log(`[build] ${path.relative(root, file)}  ${(meta.bytes / 1024).toFixed(1)} KiB`);
    }
  }
}
