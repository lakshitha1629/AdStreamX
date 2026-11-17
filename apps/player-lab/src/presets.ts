import type { MediaSourceConfig } from '@adstreamx/shared-types';

export interface Preset {
  id: string;
  group: 'VOD' | 'Live' | 'Errors' | 'Recovery';
  label: string;
  source: MediaSourceConfig;
  fallbacks?: MediaSourceConfig[];
  /** Signed-URL presets are issued by the fixture server at load time. */
  signTtl?: number;
  note?: string;
}

const captions = [
  { src: '/media/captions/short.en.vtt', srclang: 'en', label: 'English' },
  { src: '/media/captions/short.es.vtt', srclang: 'es', label: 'Español' },
];

// All presets point at the local fixture server (`npm run serve`).
export const PRESETS: Preset[] = [
  { id: 'mp4', group: 'VOD', label: 'MP4 · 12 s · WebVTT captions', source: { src: '/media/mp4/short.mp4', textTracks: captions } },
  { id: 'hls-vod', group: 'VOD', label: 'HLS VOD · MPEG-TS · 240/360/720p', source: { src: '/media/hls/vod/master.m3u8' } },
  { id: 'hls-fmp4', group: 'VOD', label: 'HLS VOD · fMP4/CMAF · 240/360p', source: { src: '/media/hls/vod-fmp4/master.m3u8' } },
  { id: 'hls-audio', group: 'VOD', label: 'HLS VOD · alternate audio (en/es)', source: { src: '/media/hls/vod-multiaudio/master.m3u8' } },
  { id: 'house-ad', group: 'VOD', label: 'House ad creative (MP4, 6 s)', source: { src: '/media/mp4/house-ad.mp4' } },
  { id: 'live-ts', group: 'Live', label: 'Live · MPEG-TS · 12 s window', source: { src: '/live/ts/12/master.m3u8' } },
  { id: 'live-dvr', group: 'Live', label: 'Live · MPEG-TS · 120 s DVR window', source: { src: '/live/ts/120/master.m3u8' } },
  { id: 'live-fmp4', group: 'Live', label: 'Live · fMP4/CMAF · 30 s window', source: { src: '/live/fmp4/30/master.m3u8' } },
  { id: 'signed-ok', group: 'Recovery', label: 'Signed URL (valid 10 min)', source: { src: 'hls/vod/master.m3u8' }, signTtl: 600 },
  {
    id: 'fallback',
    group: 'Recovery',
    label: 'Primary 404 → approved fallback',
    source: { src: '/media/mp4/does-not-exist.mp4' },
    fallbacks: [{ src: '/media/mp4/short.mp4', label: 'Backup origin' }],
  },
  { id: 'signed-expired', group: 'Errors', label: 'Signed URL (expired)', source: { src: 'hls/vod/master.m3u8' }, signTtl: -60 },
  { id: 'missing', group: 'Errors', label: 'Missing file (404)', source: { src: '/media/mp4/does-not-exist.mp4' } },
  { id: 'invalid-manifest', group: 'Errors', label: 'Invalid manifest', source: { src: '/media/errors/invalid.m3u8' } },
  { id: 'unsupported', group: 'Errors', label: 'Unsupported format', source: { src: '/media/errors/unsupported.xyz', type: 'video/x-adstreamx-unsupported' } },
  { id: 'forbidden', group: 'Errors', label: 'Forbidden (403)', source: { src: '/errors/forbidden.mp4' } },
  { id: 'server-error', group: 'Errors', label: 'Server error (500, retried)', source: { src: '/errors/server-error.m3u8' } },
  { id: 'bad-scheme', group: 'Errors', label: 'Rejected URL (javascript:)', source: { src: 'javascript:alert(1)' } },
];

export interface FaultPreset {
  id: string;
  label: string;
  body: { match: string; status?: number; delayMs?: number; abort?: boolean; count?: number };
}

export const FAULTS: FaultPreset[] = [
  { id: 'seg503', label: 'Next 3 segment requests → 503', body: { match: '/seg_', status: 503, count: 3 } },
  { id: 'segdown', label: 'All segments → 503 (outage)', body: { match: '/seg_', status: 503 } },
  { id: 'stall', label: 'Stall next 4 segments by 12 s', body: { match: '/seg_', delayMs: 12000, count: 4 } },
  { id: 'abort', label: 'Drop next 2 connections', body: { match: '/seg_', abort: true, count: 2 } },
  { id: 'pl404', label: 'Playlist 404 once', body: { match: '.m3u8', status: 404, count: 1 } },
  { id: 'mp4-503', label: 'MP4 requests → 503 ×2', body: { match: '.mp4', status: 503, count: 2 } },
];
