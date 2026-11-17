#!/usr/bin/env node
// Builds browser bundles with esbuild:
//   packages/player-sdk/dist/adstreamx.js       IIFE  (window.AdStreamX)
//   packages/player-sdk/dist/adstreamx.esm.js   ESM
//   apps/player-lab/dist/                       Player Lab (React)
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
fs.mkdirSync(sdkDir, { recursive: true });
fs.mkdirSync(labDir, { recursive: true });

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
];

for (const f of ['index.html', 'lab.css']) {
  const src = path.join(root, 'apps/player-lab/src', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(labDir, f));
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
