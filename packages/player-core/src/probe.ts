import type { PlayerErrorCode } from '@adstreamx/shared-types';
import { classifyHttpStatus } from './errors.ts';
import type { SourceKind } from './source.ts';

export interface ProbeResult {
  ok: boolean;
  code?: PlayerErrorCode;
  httpStatus?: number;
  detail: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Diagnostic probe run *after* the media element reports an error. HTMLMediaElement
 * errors do not carry HTTP status, so we fetch a small piece of the resource to tell a
 * missing file, an expired URL, a malformed playlist and a network failure apart.
 * A CORS-blocked probe is reported as inconclusive (ok: true) — never guessed.
 */
export async function probeSource(
  url: string,
  kind: SourceKind,
  opts: { fetch?: FetchLike; timeoutMs?: number; expiresAt?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const f = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
  if (!f) return { ok: true, detail: 'fetch unavailable; probe skipped' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await f(url, {
      method: 'GET',
      headers: kind === 'hls' ? {} : { Range: 'bytes=0-1023' },
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const code = classifyHttpStatus(res.status, {
        reasonHeader: res.headers.get('x-adstreamx-reason'),
        expiresAt: opts.expiresAt,
      });
      return { ok: false, code, httpStatus: res.status, detail: `HTTP ${res.status} for ${url}` };
    }
    if (kind === 'hls') {
      const text = (await res.text()).replace(/^﻿/, '');
      if (!text.trimStart().startsWith('#EXTM3U')) {
        return { ok: false, code: 'INVALID_MANIFEST', httpStatus: res.status, detail: 'playlist does not start with #EXTM3U' };
      }
      // For a master playlist, check that the first variant is reachable too.
      const variant = firstUri(text);
      if (variant && /#EXT-X-STREAM-INF/.test(text)) {
        const vurl = new URL(variant, url).href;
        const nested = await probeSource(vurl, 'hls', { ...opts, signal: ctrl.signal });
        if (!nested.ok) return { ...nested, detail: `variant: ${nested.detail}` };
      } else if (/#EXTINF/.test(text)) {
        // Media playlist: check the newest segment, so a segment outage behind a healthy
        // playlist is classified (e.g. SERVER) instead of being blamed on the format.
        const seg = lastUri(text);
        if (seg) {
          const surl = new URL(seg, url).href;
          const nested = await probeSource(surl, 'mp4', { ...opts, signal: ctrl.signal });
          if (!nested.ok) return { ...nested, detail: `segment: ${nested.detail}` };
        }
      }
    }
    return { ok: true, httpStatus: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    if (ctrl.signal.aborted && !opts.signal?.aborted) return { ok: false, code: 'NETWORK', detail: 'probe timed out' };
    if (opts.signal?.aborted) return { ok: true, detail: 'probe aborted' };
    // TypeError from fetch = network failure *or* CORS. Distinguishing is impossible from JS;
    // treat as a network error (retryable) rather than inventing a cause.
    return { ok: false, code: 'NETWORK', detail: `probe failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function lastUri(playlist: string): string | null {
  const lines = playlist.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return null;
}

function firstUri(playlist: string): string | null {
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return null;
}
