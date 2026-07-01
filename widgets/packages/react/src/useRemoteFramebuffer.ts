import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RemoteFramebufferView, type ConnectionState, type Stats } from "@habemus-papadum/rfb-widgets";
import { EMPTY_STATS } from "@habemus-papadum/rfb-ui";

/** Options for {@link useRemoteFramebuffer}. Same shape as the core `RfbViewOptions`;
 *  the wrapper owns `onState`/`onStats`/`onError` internally and forwards to yours. */
export type UseRfbOptions = ConstructorParameters<typeof RemoteFramebufferView>[1];

export interface UseRfbResult {
  /** Callback ref for the element the framebuffer canvas is created inside:
   *  `<div ref={containerRef} />`. A callback ref (not a RefObject) keeps this identical
   *  across React 18 and 19, whose RefObject typings differ. */
  containerRef: (el: HTMLDivElement | null) => void;
  /** Latest connection state (re-renders on change). */
  state: ConnectionState;
  /** Latest error, or `null` (re-renders on change). */
  error: Error | null;
  /** Capture the current frame. Rejects until the view is ready. */
  capture: (format?: "imagedata" | "blob") => Promise<ImageData | Blob>;
  /** Force a fresh connection (dispose + recreate). */
  reconnect: () => void;
  /** The live view instance, or `null` before mount / after teardown. */
  view: RemoteFramebufferView | null;
}

// Per-view stats stores, looked up by instance so `useRemoteFramebufferStats(view)` can
// subscribe. Stats are high-frequency (per frame); routing them through React state would
// cause a re-render storm, so we keep them in an external store read via
// useSyncExternalStore — only components that read stats re-render.
interface StatsStore {
  set(s: Stats): void;
  subscribe(cb: () => void): () => void;
  get(): Stats;
}
const STORES = new WeakMap<RemoteFramebufferView, StatsStore>();

function createStatsStore(): StatsStore {
  let snapshot: Stats = EMPTY_STATS;
  const listeners = new Set<() => void>();
  return {
    set(s) {
      snapshot = s;
      for (const l of listeners) l();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get() {
      return snapshot;
    },
  };
}

const NOOP_SUBSCRIBE = () => () => {};
const GET_EMPTY = () => EMPTY_STATS;

/**
 * Headless React primitive. Creates one `RemoteFramebufferView` inside `containerRef` and
 * exposes reactive `state`/`error` + `capture`/`reconnect`. Changing a connect-critical
 * option (`url`, `token`, `imageOnly`, dpr, `maxBackingDimension`, `maxInflight`,
 * `autoResize`) tears down and rebuilds the connection. Read per-frame metrics via the
 * companion {@link useRemoteFramebufferStats} to avoid re-rendering on every frame.
 */
export function useRemoteFramebuffer(options: UseRfbOptions): UseRfbResult {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((el: HTMLDivElement | null) => setContainerEl(el), []);
  const viewRef = useRef<RemoteFramebufferView | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<Error | null>(null);
  const [view, setView] = useState<RemoteFramebufferView | null>(null);
  const [epoch, setEpoch] = useState(0);

  // Latest user callbacks + full options, read by the stable wrapper callbacks so that
  // passing fresh closures each render never recreates the view.
  const cbRef = useRef(options);
  cbRef.current = options;

  const { url, token, imageOnly, devicePixelRatio, maxBackingDimension, maxInflight, autoResize } = options;

  useEffect(() => {
    if (!containerEl) return;
    const el = containerEl;
    const store = createStatsStore();
    const o = cbRef.current;
    const instance = new RemoteFramebufferView(el, {
      ...o,
      onState: (s) => {
        setState(s);
        cbRef.current.onState?.(s);
      },
      onStats: (s) => {
        store.set(s);
        cbRef.current.onStats?.(s);
      },
      onError: (e) => {
        setError(e);
        cbRef.current.onError?.(e);
      },
    });
    STORES.set(instance, store);
    viewRef.current = instance;
    setView(instance);
    setError(null);
    return () => {
      STORES.delete(instance);
      instance.dispose();
      viewRef.current = null;
      setView(null);
    };
    // Recreate only on connect-critical primitives (not options identity / callback churn).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerEl, url, token, imageOnly, devicePixelRatio, maxBackingDimension, maxInflight, autoResize, epoch]);

  const capture = useCallback(
    (format: "imagedata" | "blob" = "imagedata"): Promise<ImageData | Blob> =>
      viewRef.current
        ? viewRef.current.capture(format)
        : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
    [],
  );
  const reconnect = useCallback(() => setEpoch((e) => e + 1), []);

  return { containerRef, state, error, capture, reconnect, view };
}

/** Subscribe to the per-frame {@link Stats} of a view without re-rendering unrelated UI. */
export function useRemoteFramebufferStats(view: RemoteFramebufferView | null): Stats {
  const store = view ? STORES.get(view) : undefined;
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.get : GET_EMPTY,
    GET_EMPTY,
  );
}
