import type { Capabilities, MediaSourceConfig, QualityLevel, TrackInfo } from '@adstreamx/shared-types';
import type { AdapterContext, PlaybackAdapter, PlaybackAdapterFactory, SourceKind } from '@adstreamx/player-core';

interface AudioTrackLike {
  id: string;
  label: string;
  language: string;
  kind: string;
  enabled: boolean;
}
interface AudioTrackListLike {
  length: number;
  [i: number]: AudioTrackLike;
}

/**
 * Native HTML5 engine: hands the URL to the browser.
 * - MP4/WebM everywhere they decode.
 * - HLS only where the browser plays it natively (Safari, iOS, Android Chrome,
 *   desktop Chromium 142+). Firefox has no native HLS; that needs the hls.js adapter.
 * - Renditions are chosen by the browser and are NOT exposed to script, so manual
 *   quality selection is unavailable with this engine (reported honestly as no levels).
 * - Alternate audio is exposed only where HTMLMediaElement.audioTracks exists.
 */
class NativeAdapter implements PlaybackAdapter {
  readonly id = 'native';
  private ctx: AdapterContext;
  constructor(ctx: AdapterContext) {
    this.ctx = ctx;
  }

  load(source: MediaSourceConfig & { type: string | undefined }, _kind: SourceKind): void {
    // Assigning src runs the media element's load algorithm. Do NOT also call load():
    // that restarts resource selection and, with Chromium's native HLS, the aborted first
    // pipeline intermittently surfaces DEMUXER_ERROR_COULD_NOT_PARSE.
    this.ctx.video.src = source.src;
  }

  unload(): void {
    const v = this.ctx.video;
    if (!v.getAttribute('src') && !v.currentSrc) return;
    v.pause();
    v.removeAttribute('src');
    v.load(); // aborts network activity and resets the element
  }

  getQualityLevels(): QualityLevel[] {
    return [];
  }
  setQuality(id: string): boolean {
    return id === 'auto';
  }
  getCurrentQuality(): QualityLevel | null {
    const v = this.ctx.video;
    if (!v.videoHeight) return null;
    // What is on screen right now (browser-selected); informational only.
    return { id: `native-${v.videoHeight}`, label: `${v.videoHeight}p (browser)`, width: v.videoWidth, height: v.videoHeight };
  }

  private audioList(): AudioTrackListLike | null {
    return ((this.ctx.video as unknown as { audioTracks?: AudioTrackListLike }).audioTracks ?? null) as AudioTrackListLike | null;
  }
  getAudioTracks(): TrackInfo[] {
    const list = this.audioList();
    if (!list) return [];
    const out: TrackInfo[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      out.push({ id: t.id || `audio-${i}`, label: t.label || t.language || `Audio ${i + 1}`, language: t.language, kind: t.kind, active: t.enabled });
    }
    return out;
  }
  setAudioTrack(id: string): boolean {
    const list = this.audioList();
    if (!list) return false;
    let found = false;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      const match = (t.id || `audio-${i}`) === id;
      if (match) found = true;
    }
    if (!found) return false;
    for (let i = 0; i < list.length; i++) list[i]!.enabled = (list[i]!.id || `audio-${i}`) === id;
    return true;
  }

  destroy(): void {
    this.unload();
  }
}

export const nativeAdapter: PlaybackAdapterFactory = {
  id: 'native',
  label: 'Native HTML5',
  canPlay(kind: SourceKind, caps: Capabilities): boolean {
    if (kind === 'hls') return caps.nativeHls;
    if (kind === 'mp4') return caps.mp4H264;
    if (kind === 'webm') return typeof document !== 'undefined' && document.createElement('video').canPlayType('video/webm') !== '';
    if (kind === 'unknown') return true; // let the browser try; errors are classified afterwards
    return false; // DASH needs an MSE engine
  },
  create: (ctx) => new NativeAdapter(ctx),
};
