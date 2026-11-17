// Deterministic stand-in for HTMLVideoElement + Document, so PlayerCore lifecycle logic
// (retries, fallbacks, stale callbacks, destroy) can be unit-tested in Node without a browser.
// It models only what PlayerCore touches; browser behaviour itself is covered by Playwright.

class FakeTimeRanges {
  ranges: [number, number][] = [];
  get length() {
    return this.ranges.length;
  }
  start(i: number) {
    return this.ranges[i]![0];
  }
  end(i: number) {
    return this.ranges[i]![1];
  }
}

class FakeTextTrackList extends EventTarget {
  length = 0;
}

export class FakeVideo extends EventTarget {
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  ended = false;
  seeking = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  preload = 'metadata';
  playsInline = false;
  poster = '';
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  error: { code: number; message: string } | null = null;
  seekable = new FakeTimeRanges();
  buffered = new FakeTimeRanges();
  textTracks = new FakeTextTrackList();
  children: unknown[] = [];
  parentElement = null;
  ownerDocument: FakeDocument;
  /** When set, play() rejects with this DOMException name. */
  playRejects: string | null = null;
  attrs = new Map<string, string>();
  loadCalls = 0;

  constructor(doc: FakeDocument) {
    super();
    this.ownerDocument = doc;
  }
  get currentSrc() {
    return this.src;
  }
  getAttribute(n: string) {
    return n === 'src' ? this.src || null : (this.attrs.get(n) ?? null);
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string) {
    if (n === 'src') this.src = '';
    this.attrs.delete(n);
  }
  canPlayType(_t: string) {
    return 'maybe';
  }
  appendChild(c: unknown) {
    this.children.push(c);
    return c;
  }
  load() {
    this.loadCalls++;
    this.readyState = 0;
    this.error = null;
  }
  play(): Promise<void> {
    if (this.playRejects) {
      const name = this.playRejects;
      return Promise.reject(Object.assign(new Error(name), { name }));
    }
    this.paused = false;
    this.fire('play');
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
  // --- test drivers
  emitMetadata(duration: number, size: [number, number] = [640, 360]) {
    this.duration = duration;
    this.videoWidth = size[0];
    this.videoHeight = size[1];
    this.readyState = 1;
    this.fire('loadedmetadata');
  }
  emitError(code: number, message = '') {
    this.error = { code, message };
    this.fire('error');
  }
}

export class FakeDocument extends EventTarget {
  baseURI = 'http://test.local/page.html';
  fullscreenEnabled = true;
  fullscreenElement = null;
  documentElement = { requestFullscreen() {} };
  createElement(tag: string) {
    if (tag === 'video') return new FakeVideo(this);
    return { tag, remove() {}, kind: '', src: '', srclang: '', label: '', default: false };
  }
}

export function fakeVideo(): FakeVideo {
  return new FakeVideo(new FakeDocument());
}

/** Flush pending microtasks/macrotasks a few times (fetch mocks are promise-based). */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

export function mockFetch(handler: (url: string) => { status: number; body?: string; headers?: Record<string, string> } | 'network-error') {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const r = handler(url);
    if (r === 'network-error') throw new TypeError('Failed to fetch');
    return new Response(r.body ?? '', { status: r.status, headers: r.headers });
  };
  return Object.assign(fn, { calls });
}
