import type { Unsubscribe } from '@adstreamx/shared-types';

type Listener<P> = (payload: P) => void;

/**
 * Minimal typed event emitter.
 * - `on` returns an unsubscribe function.
 * - A throwing listener is isolated (reported through `onListenerError`) and never
 *   prevents other listeners or the player itself from running.
 * - Emitting while listeners unsubscribe is safe (iteration works on a snapshot).
 */
export class TypedEmitter<M extends object> {
  private listeners = new Map<keyof M, Set<Listener<never>>>();
  private disposed = false;

  private onListenerError: (event: string, err: unknown) => void;
  constructor(onListenerError: (event: string, err: unknown) => void = defaultListenerError) {
    this.onListenerError = onListenerError;
  }

  on<K extends keyof M>(event: K, fn: Listener<M[K]>): Unsubscribe {
    if (this.disposed) return noop;
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => this.off(event, fn);
  }

  once<K extends keyof M>(event: K, fn: Listener<M[K]>): Unsubscribe {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof M>(event: K, fn: Listener<M[K]>): void {
    this.listeners.get(event)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<M[K]>)(payload);
      } catch (err) {
        this.onListenerError(String(event), err);
      }
    }
  }

  listenerCount(event?: keyof M): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  /** Remove all listeners and refuse new ones. */
  dispose(): void {
    this.listeners.clear();
    this.disposed = true;
  }
}

function noop(): void {}
function defaultListenerError(event: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[AdStreamX] listener for "${event}" threw`, err);
}
