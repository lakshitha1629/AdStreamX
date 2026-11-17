export type KeyAction =
  | { type: 'togglePlay' }
  | { type: 'seekBy'; seconds: number }
  | { type: 'seekPercent'; percent: number }
  | { type: 'seekStart' }
  | { type: 'seekEnd' }
  | { type: 'volumeBy'; delta: number }
  | { type: 'toggleMute' }
  | { type: 'toggleFullscreen' }
  | { type: 'toggleTheater' }
  | { type: 'toggleCaptions' }
  | { type: 'togglePip' }
  | { type: 'rateBy'; delta: number };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Keyboard shortcuts (YouTube-like, documented in docs/player/keyboard.md).
 * Pure function so it is unit-testable; returns null for keys the player does not own.
 * Modifier combos (Ctrl/Cmd/Alt) are never captured, so browser and AT shortcuts keep working.
 */
export function mapKey(e: KeyLike): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key;
  switch (k) {
    case ' ':
    case 'k':
    case 'K':
      return { type: 'togglePlay' };
    case 'ArrowLeft':
      return { type: 'seekBy', seconds: -5 };
    case 'ArrowRight':
      return { type: 'seekBy', seconds: 5 };
    case 'j':
    case 'J':
      return { type: 'seekBy', seconds: -10 };
    case 'l':
    case 'L':
      return { type: 'seekBy', seconds: 10 };
    case 'ArrowUp':
      return { type: 'volumeBy', delta: 0.1 };
    case 'ArrowDown':
      return { type: 'volumeBy', delta: -0.1 };
    case 'm':
    case 'M':
      return { type: 'toggleMute' };
    case 'f':
    case 'F':
      return { type: 'toggleFullscreen' };
    case 't':
    case 'T':
      return { type: 'toggleTheater' };
    case 'c':
    case 'C':
      return { type: 'toggleCaptions' };
    case 'i':
    case 'I':
      return { type: 'togglePip' };
    case 'Home':
      return { type: 'seekStart' };
    case 'End':
      return { type: 'seekEnd' };
    case '>':
      return { type: 'rateBy', delta: 0.25 };
    case '<':
      return { type: 'rateBy', delta: -0.25 };
  }
  if (/^[0-9]$/.test(k)) return { type: 'seekPercent', percent: Number(k) * 10 };
  return null;
}

export const SHORTCUTS: [string, string][] = [
  ['Space / K', 'Play or pause'],
  ['← / →', 'Back / forward 5 s'],
  ['J / L', 'Back / forward 10 s'],
  ['↑ / ↓', 'Volume up / down'],
  ['M', 'Mute'],
  ['F', 'Fullscreen'],
  ['T', 'Theater mode'],
  ['C', 'Captions on/off'],
  ['I', 'Picture-in-Picture'],
  ['0–9', 'Jump to 0–90 % (VOD)'],
  ['Home / End', 'Start / live edge'],
  ['< / >', 'Slower / faster (VOD)'],
];
