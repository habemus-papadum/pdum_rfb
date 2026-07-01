import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";
import { RemoteFramebufferView, type ConnectionState, type Stats } from "@habemus-papadum/rfb-widgets";
import { EMPTY_STATS } from "@habemus-papadum/rfb-ui";

/** Options for {@link createRemoteFramebuffer}; same shape as the core `RfbViewOptions`. */
export type RfbSolidOptions = ConstructorParameters<typeof RemoteFramebufferView>[1];

export interface RemoteFramebufferHandle {
  /** Attach to the element the canvas is created inside: `<div ref={fb.ref} />`. */
  ref: (el: HTMLElement) => void;
  /** Reactive connection state. */
  state: Accessor<ConnectionState>;
  /** Reactive per-frame metrics. */
  stats: Accessor<Stats>;
  /** Reactive last error (or `null`). */
  error: Accessor<Error | null>;
  /** Capture the current frame; rejects until the view is ready. */
  capture: (format?: "imagedata" | "blob") => Promise<ImageData | Blob>;
  /** Force a fresh connection (dispose + recreate). */
  reconnect: () => void;
  /** The live view instance, or `null`. */
  view: Accessor<RemoteFramebufferView | null>;
}

/**
 * Headless Solid primitive. Pass options as a value or an accessor (`() => ({ url })`) for
 * reactive connect params. Exposes signals for `state`/`stats`/`error` and a `ref` for the
 * host element. Changing a connect-critical option (`url`, `token`, `imageOnly`, dpr,
 * `maxBackingDimension`, `maxInflight`, `autoResize`) recreates the connection. Must be
 * called under a reactive owner (inside a component / `createRoot`).
 */
export function createRemoteFramebuffer(
  options: RfbSolidOptions | Accessor<RfbSolidOptions>,
): RemoteFramebufferHandle {
  const getOptions: Accessor<RfbSolidOptions> = typeof options === "function" ? options : () => options;

  const [state, setState] = createSignal<ConnectionState>("connecting");
  const [stats, setStats] = createSignal<Stats>(EMPTY_STATS);
  const [error, setError] = createSignal<Error | null>(null);
  const [view, setView] = createSignal<RemoteFramebufferView | null>(null);
  const [el, setEl] = createSignal<HTMLElement | null>(null);
  const [epoch, setEpoch] = createSignal(0);

  createEffect(
    on(
      () => {
        const o = getOptions();
        return [
          el(),
          epoch(),
          o.url,
          o.token,
          o.imageOnly,
          o.devicePixelRatio,
          o.maxBackingDimension,
          o.maxInflight,
          o.autoResize,
        ];
      },
      () => {
        const node = el();
        if (!node) return;
        const o = getOptions();
        const instance = new RemoteFramebufferView(node, {
          ...o,
          onState: (s) => {
            setState(s);
            o.onState?.(s);
          },
          onStats: (s) => {
            setStats(s);
            o.onStats?.(s);
          },
          onError: (e) => {
            setError(e);
            o.onError?.(e);
          },
        });
        setView(instance);
        setError(null);
        onCleanup(() => instance.dispose());
      },
    ),
  );

  return {
    ref: setEl,
    state,
    stats,
    error,
    capture: (format = "imagedata") =>
      view() ? view()!.capture(format) : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
    reconnect: () => setEpoch((e) => e + 1),
    view,
  };
}
