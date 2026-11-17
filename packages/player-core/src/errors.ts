import type { PlayerErrorCode, PlayerErrorInfo } from '@adstreamx/shared-types';

/** Viewer-safe messages. Technical detail goes in `detail`, never in `message`. */
export const ERROR_MESSAGES: Record<PlayerErrorCode, string> = {
  INVALID_SOURCE: 'This video address is not valid.',
  SOURCE_NOT_ALLOWED: 'This video source is not approved for this player.',
  UNSUPPORTED_FORMAT: 'This video format is not supported in your browser.',
  MISSING_FILE: 'The video could not be found.',
  INVALID_MANIFEST: 'The video stream is damaged or not a valid playlist.',
  EXPIRED_URL: 'This video link has expired. Please reload the page.',
  FORBIDDEN: 'You do not have access to this video.',
  NETWORK: 'A network problem interrupted playback.',
  SERVER: 'The video server is having trouble right now.',
  DECODE: 'The video could not be decoded.',
  STARTUP_TIMEOUT: 'The video is taking too long to start.',
  STALLED: 'Playback stalled while loading more video.',
  PLAY_BLOCKED: 'Press play to start the video.',
  DESTROYED: 'The player has been closed.',
  FEATURE_UNAVAILABLE: 'This feature is not available in this player.',
  PERMISSION_DENIED: 'This action is not allowed.',
  INVALID_COMMAND: 'The request was not valid.',
  UNKNOWN: 'Something went wrong while playing this video.',
};

/** Codes where an automatic retry of the same source can plausibly help. */
const RECOVERABLE: ReadonlySet<PlayerErrorCode> = new Set<PlayerErrorCode>([
  'NETWORK',
  'SERVER',
  'STARTUP_TIMEOUT',
  'STALLED',
]);

export function isRecoverable(code: PlayerErrorCode): boolean {
  return RECOVERABLE.has(code);
}

export function makeError(
  code: PlayerErrorCode,
  opts: { detail?: string; httpStatus?: number; sourceUrl?: string; fatal?: boolean; now?: number; recoverable?: boolean } = {},
): PlayerErrorInfo {
  return {
    code,
    message: ERROR_MESSAGES[code],
    detail: opts.detail,
    httpStatus: opts.httpStatus,
    recoverable: opts.recoverable ?? isRecoverable(code),
    fatal: opts.fatal ?? false,
    sourceUrl: opts.sourceUrl,
    timestamp: opts.now ?? Date.now(),
  };
}

/** Map an HTTP failure to an error code. */
export function classifyHttpStatus(
  status: number,
  ctx: { reasonHeader?: string | null; expiresAt?: number; now?: number } = {},
): PlayerErrorCode {
  const now = ctx.now ?? Date.now();
  const reason = (ctx.reasonHeader ?? '').toLowerCase();
  if (status === 404) return 'MISSING_FILE';
  if (status === 410) return 'EXPIRED_URL';
  if (status === 401 || status === 403) {
    if (reason === 'expired' || (ctx.expiresAt !== undefined && ctx.expiresAt <= now)) return 'EXPIRED_URL';
    return 'FORBIDDEN';
  }
  if (status === 408 || status === 429) return 'NETWORK';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'UNKNOWN';
  return 'UNKNOWN';
}

/** HTMLMediaElement MediaError.code values. */
export const MEDIA_ERR = { ABORTED: 1, NETWORK: 2, DECODE: 3, SRC_NOT_SUPPORTED: 4 } as const;

/** Classification from MediaError alone (used when a diagnostic probe is unavailable or passes). */
export function classifyMediaErrorCode(code: number | undefined): PlayerErrorCode {
  switch (code) {
    case MEDIA_ERR.NETWORK:
      return 'NETWORK';
    case MEDIA_ERR.DECODE:
      return 'DECODE';
    case MEDIA_ERR.SRC_NOT_SUPPORTED:
      return 'UNSUPPORTED_FORMAT';
    default:
      return 'UNKNOWN';
  }
}

/** Public error class thrown by promise-returning SDK methods. */
export class AdStreamXError extends Error {
  readonly info: PlayerErrorInfo;
  constructor(info: PlayerErrorInfo) {
    super(info.message);
    this.name = 'AdStreamXError';
    this.info = info;
  }
  get code(): PlayerErrorCode {
    return this.info.code;
  }
}
