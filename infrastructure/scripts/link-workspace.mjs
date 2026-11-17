#!/usr/bin/env node
// Offline stand-in for `pnpm install` workspace linking.
//
// Why this exists: the environment this repo was bootstrapped in had no package-registry
// access (see docs/BLOCKERS.md). pnpm could not resolve external devDependencies, so it
// could not link workspace packages either. This script creates the same
// node_modules/@adstreamx/<pkg> links pnpm would create. Once `pnpm install` works,
// it replaces these links and this script becomes unnecessary.
//
// Optional: TOOLCHAIN_DIR=/path/to/node_modules links pre-installed devDependencies
// (esbuild, react, playwright, typescript, @types/node) into ./node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nm = path.join(root, 'node_modules');
const scope = path.join(nm, '@adstreamx');
fs.mkdirSync(scope, { recursive: true });

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
function link(target, at) {
  let exists = false;
  try {
    fs.lstatSync(at);
    exists = true;
  } catch {
    /* does not exist */
  }
  if (exists) {
    let same = false;
    try {
      same = fs.realpathSync(at) === fs.realpathSync(target);
    } catch {
      /* broken link (e.g. created from another OS) — replace it */
    }
    if (same) return false;
    fs.rmSync(at, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, linkType);
  return true;
}

let count = 0;
for (const group of ['packages', 'apps']) {
  const dir = path.join(root, group);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const pkgJson = path.join(dir, name, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    if (!pkg.name?.startsWith('@adstreamx/')) continue;
    if (link(path.join(dir, name), path.join(nm, pkg.name))) count++;
  }
}

const toolchain = process.env.TOOLCHAIN_DIR;
if (toolchain) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const dep of Object.keys(rootPkg.devDependencies ?? {})) {
    const src = path.join(toolchain, dep);
    if (!fs.existsSync(src)) {
      console.warn(`[link] toolchain missing ${dep}`);
      continue;
    }
    const want = rootPkg.devDependencies[dep];
    const have = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
    if (have !== want) console.warn(`[link] ${dep}: pinned ${want}, toolchain has ${have}`);
    if (link(src, path.join(nm, dep))) count++;
  }
  // esbuild needs its platform binary package next to it.
  const esb = path.join(toolchain, '@esbuild');
  if (fs.existsSync(esb)) link(esb, path.join(nm, '@esbuild'));
}
console.log(`[link] workspace linked (${count} new links) in ${nm}`);
