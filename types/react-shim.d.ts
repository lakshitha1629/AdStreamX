// TEMPORARY loose typings (shared by apps/player-lab and packages/react-player): @types/react / @types/react-dom could not be installed (no registry
// access, see docs/BLOCKERS.md). Replace by adding @types/react@19 and deleting this file.
declare module 'react' {
  export type ReactNode = unknown;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export interface RefObject<T> {
    current: T;
  }
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  export function useRef<T>(initial: T): RefObject<T>;
  export function useMemo<T>(factory: () => T, deps: unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]): T;
  export function useReducer<S, A>(reducer: (s: S, a: A) => S, init: S): [S, Dispatch<A>];
  export const StrictMode: (props: { children?: ReactNode }) => ReactNode;
  export type CSSProperties = Record<string, string | number>;
  export type Ref<T> = ((instance: T | null) => void) | RefObject<T | null> | null;
  export type ForwardedRef<T> = Ref<T>;
  export interface ForwardRefComponent<P, T> {
    (props: P & { ref?: Ref<T> }): ReactNode;
    displayName?: string;
  }
  export function forwardRef<T, P>(render: (props: P, ref: ForwardedRef<T>) => ReactNode): ForwardRefComponent<P, T>;
  export function useImperativeHandle<T>(ref: Ref<T> | undefined, create: () => T, deps?: unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  export const Fragment: unknown;
}
declare module 'react/jsx-runtime' {
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}
declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: unknown): void; unmount(): void };
}
declare namespace JSX {
  type Element = unknown;
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
}
