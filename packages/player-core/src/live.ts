import type { LiveConfig, LiveInfo } from '@adstreamx/shared-types';

/** Live position maths, kept pure so it can be unit-tested without a browser. */
export function computeLiveInfo(
  currentTime: number,
  seekableStart: number,
  seekableEnd: number,
  cfg: Pick<LiveConfig, 'liveEdgeOffset' | 'liveEdgeTolerance'>,
): LiveInfo {
  const latency = Math.max(0, seekableEnd - currentTime);
  return {
    latency,
    dvr: true,
    estimated: false,
    atLiveEdge: latency <= cfg.liveEdgeOffset + cfg.liveEdgeTolerance,
    dvrWindow: Math.max(0, seekableEnd - seekableStart),
    seekableStart,
    seekableEnd,
  };
}

/**
 * Live position for engines that expose no seekable range (e.g. Chromium's native HLS).
 * driftSec = wall-clock seconds since joining minus media seconds played since joining:
 * it grows while paused or stalled and shrinks while catching up at rate > 1.
 * The viewer is "at the live edge" while the drift stays within tolerance.
 */
export function estimateLiveInfo(driftSec: number, joinBufferAhead: number, cfg: Pick<LiveConfig, 'liveEdgeTolerance'>): LiveInfo {
  const drift = Math.max(0, driftSec);
  return {
    latency: Math.max(0, joinBufferAhead) + drift,
    dvr: false,
    estimated: true,
    atLiveEdge: drift <= cfg.liveEdgeTolerance,
    dvrWindow: 0,
    seekableStart: 0,
    seekableEnd: 0,
  };
}

/** Target time for goLive(): just behind the newest media, never before the window start. */
export function liveEdgeTarget(seekableStart: number, seekableEnd: number, offset: number): number {
  return Math.max(seekableStart, seekableEnd - Math.max(0, offset));
}

/** Clamp a DVR seek to the seekable window (leaving a small safety margin at the end). */
export function clampDvrSeek(target: number, seekableStart: number, seekableEnd: number, edgeMargin = 0.5): number {
  if (!Number.isFinite(target)) return seekableEnd - edgeMargin;
  return Math.min(Math.max(target, seekableStart), Math.max(seekableStart, seekableEnd - edgeMargin));
}

export type CatchUpDecision = { action: 'none' } | { action: 'rate'; rate: number } | { action: 'seek' };

/**
 * Latency control. Inside the tolerance band → rate 1. Moderately behind → speed up
 * proportionally (bounded by maxCatchUpRate). Far behind → recommend a seek to the edge.
 * Only used while the viewer is "following live" (has not deliberately scrubbed into DVR).
 */
export function catchUpDecision(latency: number, cfg: LiveConfig): CatchUpDecision {
  if (!cfg.catchUp) return { action: 'none' };
  const over = latency - cfg.targetLatency;
  if (over > cfg.maxDriftBeforeSeek) return { action: 'seek' };
  if (over <= cfg.liveEdgeTolerance) return { action: 'rate', rate: 1 };
  const span = Math.max(0.001, cfg.maxDriftBeforeSeek - cfg.liveEdgeTolerance);
  const frac = Math.min(1, (over - cfg.liveEdgeTolerance) / span);
  const rate = 1 + frac * (cfg.maxCatchUpRate - 1);
  return { action: 'rate', rate: Math.round(rate * 1000) / 1000 };
}

/** Last range of a TimeRanges-like object, or null. */
export function lastRange(r: { length: number; start(i: number): number; end(i: number): number } | null | undefined): [number, number] | null {
  if (!r || r.length === 0) return null;
  return [r.start(0), r.end(r.length - 1)];
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
