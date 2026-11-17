#!/usr/bin/env node
// Writes media/manifest.json describing generated fixtures (sizes + live source segment
// counts) so the server and tests do not have to guess.
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push({ path: path.relative(out, p).split(path.sep).join('/'), bytes: fs.statSync(p).size });
  }
})(out);

const live = {};
for (const kind of ['ts', 'fmp4']) {
  const base = path.join(out, 'live-src', kind);
  if (!fs.existsSync(base)) continue;
  live[kind] = {};
  for (const v of fs.readdirSync(base)) {
    const idx = path.join(base, v, 'index.m3u8');
    if (!fs.existsSync(idx)) continue;
    const txt = fs.readFileSync(idx, 'utf8');
    const durations = [...txt.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    const segs = txt.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    live[kind][v] = { segments: segs, durations, hasInit: fs.existsSync(path.join(base, v, 'init.mp4')) };
  }
}
fs.writeFileSync(
  path.join(out, 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), files, live }, null, 2),
);
