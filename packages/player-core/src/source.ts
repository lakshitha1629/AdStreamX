import type { MediaSourceConfig, PlayerErrorCode } from '@adstreamx/shared-types';

export const MIME_HLS = 'application/vnd.apple.mpegurl';
export const MIME_MP4 = 'video/mp4';
export const MIME_DASH = 'application/dash+xml';

const HLS_TYPES = new Set([MIME_HLS, 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);

export type SourceKind = 'hls' | 'mp4' | 'webm' | 'dash' | 'unknown';

export function inferMimeType(src: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(src, 'http://placeholder.invalid').pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (pathname.endsWith('.m3u8')) return MIME_HLS;
  if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) return MIME_MP4;
  if (pathname.endsWith('.webm')) return 'video/webm';
  if (pathname.endsWith('.mpd')) return MIME_DASH;
  if (pathname.endsWith('.mov')) return 'video/quicktime';
  return undefined;
}

export function sourceKind(source: Pick<MediaSourceConfig, 'src' | 'type'>): SourceKind {
  const type = (source.type ?? inferMimeType(source.src) ?? '').toLowerCase();
  if (HLS_TYPES.has(type)) return 'hls';
  if (type === MIME_MP4) return 'mp4';
  if (type === 'video/webm') return 'webm';
  if (type === MIME_DASH) return 'dash';
  return 'unknown';
}

export type SourceValidation =
  | { ok: true; source: MediaSourceConfig & { type: string | undefined }; url: URL }
  | { ok: false; code: PlayerErrorCode; detail: string };

/**
 * Validate a media source before it reaches the media element.
 * - only http(s) (or page-relative) URLs; javascript:, data:, file: etc. are rejected
 * - optional origin allowlist (approved sources)
 * - text track URLs are validated with the same rules
 */
export function validateSource(
  source: MediaSourceConfig | null | undefined,
  opts: { baseUrl: string; allowedOrigins?: string[] },
): SourceValidation {
  if (!source || typeof source.src !== 'string' || source.src.trim() === '') {
    return { ok: false, code: 'INVALID_SOURCE', detail: 'source.src is empty' };
  }
  const check = (raw: string): URL | { code: PlayerErrorCode; detail: string } => {
    let url: URL;
    try {
      url = new URL(raw.trim(), opts.baseUrl);
    } catch {
      return { code: 'INVALID_SOURCE', detail: `unparseable URL: ${raw}` };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { code: 'INVALID_SOURCE', detail: `protocol ${url.protocol} is not allowed` };
    }
    if (url.username || url.password) {
      return { code: 'INVALID_SOURCE', detail: 'credentials in URL are not allowed' };
    }
    const allow = opts.allowedOrigins?.filter(Boolean) ?? [];
    if (allow.length > 0 && !allow.some((o) => originMatches(url, o))) {
      return { code: 'SOURCE_NOT_ALLOWED', detail: `origin ${url.origin} is not in allowedSourceOrigins` };
    }
    return url;
  };

  const main = check(source.src);
  if (!(main instanceof URL)) return { ok: false, ...main };
  for (const t of source.textTracks ?? []) {
    const r = check(t.src);
    if (!(r instanceof URL)) return { ok: false, code: r.code, detail: `text track: ${r.detail}` };
  }
  const type = source.type ?? inferMimeType(main.href);
  return { ok: true, source: { ...source, src: main.href, type }, url: main };
}

/** Allowlist entry: exact origin ("https://cdn.example.com") or wildcard subdomain ("https://*.example.com"). */
export function originMatches(url: URL, entry: string): boolean {
  const m = /^(https?):\/\/(\*\.)?([^/:]+)(?::(\d+))?\/?$/i.exec(entry.trim());
  if (!m) return false;
  const [, proto, wildcard, host, port] = m;
  if (url.protocol !== `${proto!.toLowerCase()}:`) return false;
  const wantPort = port ?? '';
  if (url.port !== wantPort) return false;
  const h = url.hostname.toLowerCase();
  const base = host!.toLowerCase();
  return wildcard ? h.endsWith('.' + base) : h === base;
}
