import type { PlaybackAdapterFactory } from '@adstreamx/player-core';
import { nativeAdapter } from './native.ts';

export { nativeAdapter };

/**
 * Engines bundled by default. hls.js and Video.js 8 adapters are planned
 * (docs/adr/0003-playback-adapters.md) but are not included until their packages can be
 * installed and tested — see docs/BLOCKERS.md.
 */
export const defaultAdapters: PlaybackAdapterFactory[] = [nativeAdapter];
