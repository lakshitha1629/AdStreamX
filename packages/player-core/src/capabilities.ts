import type { Capabilities } from '@adstreamx/shared-types';
import { MIME_HLS } from './source.ts';

/**
 * Feature-detect what this browser can do. Nothing here is assumed from the user agent:
 * every flag comes from an API presence check or canPlayType().
 */
export function detectCapabilities(engines: string[] = [], doc: Document | undefined = globalThis.document): Capabilities {
  if (!doc) {
    return {
      mp4H264: false,
      nativeHls: false,
      mediaSource: false,
      managedMediaSource: false,
      fullscreen: false,
      videoElementFullscreen: false,
      pictureInPicture: false,
      audioTrackApi: false,
      videoTrackApi: false,
      textTracks: false,
      touch: false,
      engines,
    };
  }
  const v = doc.createElement('video');
  const can = (t: string) => v.canPlayType(t) !== '';
  const w = globalThis as unknown as Record<string, unknown>;
  const el = doc.documentElement as unknown as Record<string, unknown>;
  return {
    mp4H264: can('video/mp4; codecs="avc1.4d401f, mp4a.40.2"'),
    nativeHls: can(MIME_HLS) || can('application/x-mpegURL'),
    mediaSource: typeof w.MediaSource === 'function',
    managedMediaSource: typeof w.ManagedMediaSource === 'function',
    fullscreen: typeof el.requestFullscreen === 'function' && doc.fullscreenEnabled !== false,
    videoElementFullscreen: typeof (v as unknown as Record<string, unknown>).webkitEnterFullscreen === 'function',
    pictureInPicture: 'pictureInPictureEnabled' in doc && (doc as Document & { pictureInPictureEnabled: boolean }).pictureInPictureEnabled === true,
    audioTrackApi: 'audioTracks' in v,
    videoTrackApi: 'videoTracks' in v,
    textTracks: 'textTracks' in v,
    touch: 'ontouchstart' in globalThis || (globalThis.navigator?.maxTouchPoints ?? 0) > 0,
    engines,
  };
}
