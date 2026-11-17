#!/usr/bin/env node
// AdStreamX fixture & media test server (local development and automated tests only).
//
//  /media/*                       static fixtures (byte ranges, MIME types, CORS, cache rules)
//  /live/<ts|fmp4>/<window>[/at<epochMs>]/master.m3u8
//                                 simulated live HLS: a wall-clock sliding window of <window>
//                                 seconds over a looping 120 s segment set, with
//                                 MEDIA-SEQUENCE, DISCONTINUITY-SEQUENCE and PROGRAM-DATE-TIME
//  /signed/<exp>/<sig>/<path>     path-token signed URLs (HMAC); 403 + reason once expired
//  /errors/*                      canned HTTP failures (403/410/500) and malformed fixtures
//  /__faults                      fault injection control (FIXTURE_FAULTS=1, same-origin only)
//  /__requests                    recent request log (for retry/backoff assertions)
//  /__sign?path=&ttl=             issue a signed URL for a fixture path (dev only)
//  /__analytics                   test ingest: POST batches (dedup by eventId), GET, DELETE
//  /lab/, /embed/, /sdk/, /e2e/   built Player Lab, iframe player, SDK bundle, e2e test pages
//
// Zero dependencies: runs with plain `node` (>= 18).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MEDIA = path.join(ROOT, 'infrastructure/fixtures/media');
const HOST = process.env.FIXTURE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.FIXTURE_PORT ?? 8080);
// Extra ports serve the same content as additional origins (cross-origin iframe tests).
const ALT_PORTS = (process.env.FIXTURE_ALT_PORTS ?? process.env.FIXTURE_ALT_PORT ?? '')
  .split(',')
  .map((p) => Number(p.trim()))
  .filter((p) => p > 0);
const FAULTS_ENABLED = (process.env.FIXTURE_FAULTS ?? '1') === '1';
const SIGN_SECRET = process.env.FIXTURE_SIGN_SECRET ?? crypto.randomBytes(16).toString('hex');
const QUIET = process.env.FIXTURE_QUIET === '1';

const STATIC_MOUNTS = {
  '/lab/': path.join(ROOT, 'apps/player-lab/dist'),
  '/embed/': path.join(ROOT, 'apps/embed-player/dist'),
  '/sdk/': path.join(ROOT, 'packages/player-sdk/dist'),
  '/e2e/': path.join(ROOT, 'tests/e2e/pages'),
};

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.aac': 'audio/aac',
  '.vtt': 'text/vtt; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.xml': 'application/xml; charset=utf-8',
  '.xyz': 'application/x-adstreamx-unsupported',
};

// ---------------------------------------------------------------------------------------
// Live simulation
// ---------------------------------------------------------------------------------------
let manifest = loadManifest();
function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(MEDIA, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}
// Epoch chosen so a full 120 s of history exists at boot (DVR windows are full immediately).
const LIVE_EPOCH_MS = Number(process.env.FIXTURE_LIVE_EPOCH_MS ?? Date.now() - 120_000);
const LIVE_VARIANTS = {
  ts: [
    { id: 'v240p', bandwidth: 520000, resolution: '426x240' },
    { id: 'v360p', bandwidth: 1000000, resolution: '640x360' },
  ],
  fmp4: [{ id: 'v360p', bandwidth: 900000, resolution: '640x360' }],
};

export function livePlaylist(kind, variant, windowSec, nowMs = Date.now(), epochMs = LIVE_EPOCH_MS) {
  const src = manifest?.live?.[kind]?.[variant];
  if (!src) return null;
  const count = src.segments.length;
  const segDur = src.durations[0] ?? 2;
  const elapsed = (nowMs - epochMs) / 1000;
  const last = Math.floor(elapsed / segDur) - 1; // last fully produced segment
  if (last < 0) return null;
  const n = Math.max(3, Math.ceil(windowSec / segDur));
  const first = Math.max(0, last - n + 1);
  const discSeq = first > 0 ? Math.floor((first - 1) / count) : 0;
  const out = [
    '#EXTM3U',
    `#EXT-X-VERSION:${kind === 'fmp4' ? 7 : 3}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(segDur)}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${discSeq}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  if (kind === 'fmp4') out.push(`#EXT-X-MAP:URI="/media/live-src/${kind}/${variant}/init.mp4"`);
  for (let i = first; i <= last; i++) {
    if (i > 0 && i % count === 0) out.push('#EXT-X-DISCONTINUITY');
    out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(epochMs + i * segDur * 1000).toISOString()}`);
    out.push(`#EXTINF:${(src.durations[i % count] ?? segDur).toFixed(3)},`);
    out.push(`/media/live-src/${kind}/${variant}/${src.segments[i % count]}`);
  }
  return out.join('\n') + '\n';
}

function liveMaster(kind) {
  const vs = LIVE_VARIANTS[kind];
  if (!vs) return null;
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${kind === 'fmp4' ? 7 : 3}`, '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const v of vs) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution},CODECS="avc1.4d401f,mp4a.40.2"`,
    );
    lines.push(`${v.id}.m3u8`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------
// Faults & request log
// ---------------------------------------------------------------------------------------
/** @type {{id:string,match:string,status?:number,delayMs?:number,abort?:boolean,remaining:number,hits:number}[]} */
let faults = [];
/** Test analytics ingest: events by eventId (duplicates counted, not stored twice). */
const analytics = { events: new Map(), batches: 0, duplicates: 0, rejected: 0 };
const requestLog = [];
let requestSeq = 0;

function takeFault(urlPath) {
  for (const f of faults) {
    if (f.remaining === 0) continue;
    if (!urlPath.includes(f.match)) continue;
    if (f.remaining > 0) f.remaining--;
    f.hits++;
    return f;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------
function sign(exp) {
  return crypto.createHmac('sha256', SIGN_SECRET).update(String(exp)).digest('hex').slice(0, 32);
}

function mediaHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-AdStreamX-Reason',
    'Timing-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function cacheControlFor(file, { live = false, app = false } = {}) {
  if (live) return 'no-store';
  if (app) return 'no-cache';
  if (/\.(ts|m4s|aac|mp4)$/.test(file)) return 'public, max-age=31536000, immutable';
  return 'no-cache'; // VOD playlists, captions, json
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function serveFile(req, res, file, { cors = true, cache } = {}) {
  let st;
  try {
    st = fs.statSync(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.statSync(file);
    }
  } catch {
    return send(res, 404, 'Not found', cors ? mediaHeaders({ 'X-AdStreamX-Reason': 'missing' }) : {});
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const base = {
    ...(cors ? mediaHeaders() : { 'X-Content-Type-Options': 'nosniff' }),
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache ?? cacheControlFor(file),
    'Last-Modified': st.mtime.toUTCString(),
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start, end;
    if (m && (m[1] || m[2])) {
      if (m[1] === '') {
        start = Math.max(0, st.size - Number(m[2]));
        end = st.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      }
    }
    if (start === undefined || start > end || start >= st.size) {
      return send(res, 416, 'Range not satisfiable', { ...base, 'Content-Range': `bytes */${st.size}` });
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// ---------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://local');
  const p = decodeURIComponent(url.pathname);
  const entry = { seq: ++requestSeq, t: Date.now(), method: req.method, path: p + url.search, status: 0 };
  requestLog.push(entry);
  if (requestLog.length > 1000) requestLog.shift();
  res.on('finish', () => {
    entry.status = res.statusCode;
    if (!QUIET && !p.startsWith('/__')) console.log(`${res.statusCode} ${req.method} ${p}`);
  });

  if (p === '/__analytics') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method === 'GET') {
      return send(res, 200, JSON.stringify({ batches: analytics.batches, duplicates: analytics.duplicates, rejected: analytics.rejected, events: [...analytics.events.values()] }), { ...cors, 'Content-Type': 'application/json' });
    }
    if (req.method === 'DELETE') {
      analytics.events.clear();
      analytics.batches = analytics.duplicates = analytics.rejected = 0;
      return send(res, 204, '', cors);
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req, 64 * 1024);
      } catch (e) {
        analytics.rejected++;
        return send(res, 413, String(e.message), cors);
      }
      if (body?.schema !== 1 || !Array.isArray(body.events) || body.events.length > 500) {
        analytics.rejected++;
        return send(res, 400, 'invalid batch', cors);
      }
      analytics.batches++;
      for (const ev of body.events) {
        if (typeof ev?.eventId !== 'string' || typeof ev?.type !== 'string') continue;
        if (analytics.events.has(ev.eventId)) analytics.duplicates++;
        else analytics.events.set(ev.eventId, ev);
      }
      return send(res, 202, '', cors);
    }
  }

  const isMediaRoute = /^\/(media|live|signed|errors)\//.test(p);
  if (req.method === 'OPTIONS' && isMediaRoute) {
    res.writeHead(204, { ...mediaHeaders(), 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '600' });
    return res.end();
  }

  // ---- control endpoints (same-origin, custom header required → blocks cross-site CSRF)
  if (p.startsWith('/__')) {
    if (p === '/__requests' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(res, 200, JSON.stringify(requestLog.filter((r) => r.seq > since)), { 'Content-Type': 'application/json' });
    }
    if (p === '/__sign' && req.method === 'GET') {
      const rel = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
      const ttl = Math.min(86400, Math.max(-3600, Number(url.searchParams.get('ttl') ?? 300)));
      const exp = Math.floor(Date.now() / 1000) + ttl;
      return send(res, 200, JSON.stringify({ url: `/signed/${exp}/${sign(exp)}/${rel}`, expiresAt: exp * 1000 }), {
        'Content-Type': 'application/json',
      });
    }
    if (p === '/__faults') {
      if (!FAULTS_ENABLED) return send(res, 404, 'fault injection disabled');
      if (req.method === 'GET') return send(res, 200, JSON.stringify(faults), { 'Content-Type': 'application/json' });
      if (req.headers['x-adstreamx-test'] !== '1') return send(res, 403, 'missing x-adstreamx-test header');
      if (req.method === 'DELETE') {
        faults = [];
        return send(res, 204, '');
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return send(res, 400, String(e.message));
        }
        if (typeof body.match !== 'string' || !body.match) return send(res, 400, 'match (string) required');
        const status = body.status === undefined ? undefined : Number(body.status);
        if (status !== undefined && !(status >= 400 && status <= 599)) return send(res, 400, 'status must be 4xx/5xx');
        const f = {
          id: crypto.randomUUID(),
          match: body.match,
          status,
          delayMs: body.delayMs ? Math.min(30000, Math.max(0, Number(body.delayMs))) : undefined,
          abort: body.abort === true,
          remaining: body.count === undefined ? -1 : Math.max(-1, Math.floor(Number(body.count))),
          hits: 0,
        };
        faults.push(f);
        return send(res, 201, JSON.stringify(f), { 'Content-Type': 'application/json' });
      }
    }
    if (p === '/__reload-manifest' && req.method === 'POST') {
      manifest = loadManifest();
      return send(res, 204, '');
    }
    return send(res, 404, 'unknown control endpoint');
  }

  if (p === '/health') return send(res, 200, JSON.stringify({ ok: true, fixtures: !!manifest }), { 'Content-Type': 'application/json' });
  if (p === '/') {
    res.writeHead(302, { Location: '/lab/' });
    return res.end();
  }

  // ---- fault injection applies to media routes only
  if (isMediaRoute) {
    const f = takeFault(p);
    if (f) {
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.abort) return req.socket.destroy();
      if (f.status) return send(res, f.status, `injected fault ${f.status}`, mediaHeaders({ 'X-AdStreamX-Reason': 'injected' }));
    }
  }

  if (p.startsWith('/media/')) {
    const file = safeJoin(MEDIA, p.slice('/media/'.length));
    if (!file) return send(res, 400, 'bad path');
    return serveFile(req, res, file);
  }

  // Optional "/at<epochMs>" pins the live clock (tests use it to schedule a loop boundary).
  let m = /^\/live\/(ts|fmp4)\/(\d+)(?:\/at(\d{10,15}))?\/([\w-]+)\.m3u8$/.exec(p);
  if (m) {
    const [, kind, win, at, name] = m;
    const windowSec = Math.min(600, Math.max(6, Number(win)));
    const epoch = at ? Number(at) : LIVE_EPOCH_MS;
    const body = name === 'master' ? liveMaster(kind) : livePlaylist(kind, name, windowSec, Date.now(), epoch);
    if (!body) return send(res, 404, 'unknown live variant (did you run npm run fixtures?)', mediaHeaders());
    res.writeHead(200, { ...mediaHeaders(), 'Content-Type': MIME['.m3u8'], 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  m = /^\/signed\/(\d+)\/([a-f0-9]{32})\/(.+)$/.exec(p);
  if (m) {
    const [, exp, sig, rel] = m;
    const good = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(exp)));
    if (!good) return send(res, 403, 'bad signature', mediaHeaders({ 'X-AdStreamX-Reason': 'bad-signature' }));
    if (Number(exp) * 1000 < Date.now()) return send(res, 403, 'expired', mediaHeaders({ 'X-AdStreamX-Reason': 'expired' }));
    const file = safeJoin(MEDIA, rel);
    if (!file) return send(res, 400, 'bad path');
    return serveFile(req, res, file);
  }

  if (p.startsWith('/errors/')) {
    const name = p.slice('/errors/'.length);
    if (name.startsWith('forbidden')) return send(res, 403, 'forbidden', mediaHeaders({ 'X-AdStreamX-Reason': 'forbidden' }));
    if (name.startsWith('gone')) return send(res, 410, 'gone', mediaHeaders({ 'X-AdStreamX-Reason': 'expired' }));
    if (name.startsWith('server-error')) return send(res, 500, 'server error', mediaHeaders({ 'X-AdStreamX-Reason': 'server' }));
    const file = safeJoin(path.join(MEDIA, 'errors'), name);
    if (!file) return send(res, 400, 'bad path');
    return serveFile(req, res, file);
  }

  for (const [prefix, dir] of Object.entries(STATIC_MOUNTS)) {
    if (p === prefix.slice(0, -1)) {
      res.writeHead(302, { Location: prefix });
      return res.end();
    }
    if (p.startsWith(prefix)) {
      const file = safeJoin(dir, p.slice(prefix.length) || 'index.html');
      if (!file) return send(res, 400, 'bad path');
      // The Lab must not be framed by other sites; the embed page is meant to be framed
      // (production: frame-ancestors from the player's allowed embed domains — Phase 6).
      if (prefix === '/lab/') res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      return serveFile(req, res, file, { cors: false, cache: 'no-cache' });
    }
  }
  send(res, 404, 'Not found');
}

export function startServer({ port = PORT, host = HOST } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 5000;
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!manifest) console.warn('[fixtures] media/manifest.json missing — run `npm run fixtures` first.');
  const servers = [await startServer()];
  for (const port of ALT_PORTS) servers.push(await startServer({ port }));
  console.log(`[fixtures] http://${HOST}:${PORT}  (Player Lab: http://${HOST}:${PORT}/lab/)`);
  for (const port of ALT_PORTS) console.log(`[fixtures] extra origin http://${HOST}:${port}`);
  console.log(`[fixtures] fault injection ${FAULTS_ENABLED ? 'ENABLED' : 'disabled'}`);
  const shutdown = () => {
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
