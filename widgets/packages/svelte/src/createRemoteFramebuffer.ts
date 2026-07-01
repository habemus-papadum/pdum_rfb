import { type Readable, writable } from "svelte/store";
import type { Action } from "svelte/action";
import { RemoteFramebufferView, type ConnectionState, type Stats } from "@habemus-papadum/rfb-widgets";
import { EMPTY_STATS } from "@habemus-papadum/rfb-ui";

/** Options for {@link createRemoteFramebuffer}; same shape as the core `RfbViewOptions`. */
export type RfbSvelteOptions = ConstructorParameters<typeof RemoteFramebufferView>[1];

export interface RemoteFramebufferHandle {
  /** Svelte action: `<div use:fb.action={options} />` creates the view inside the node. */
  action: Action<HTMLElement, RfbSvelteOptions | undefined>;
  /** Reactive connection state. */
  state: Readable<ConnectionState>;
  /** Reactive per-frame metrics. */
  stats: Readable<Stats>;
  /** Reactive last error (or `null`). */
  error: Readable<Error | null>;
  /** Capture the current frame; rejects until the view is ready. */
  capture: (format?: "imagedata" | "blob") => Promise<ImageData | Blob>;
  /** Force a fresh connection (dispose + recreate). */
  reconnect: () => void;
  /** The live view instance, or `null`. */
  view: () => RemoteFramebufferView | null;
}

const connectKey = (o: RfbSvelteOptions): string =>
  JSON.stringify([o.url, o.token, o.imageOnly, o.devicePixelRatio, o.maxBackingDimension, o.maxInflight, o.autoResize]);

/**
 * Headless Svelte primitive. Returns a `use:` action plus `state`/`stats`/`error` stores.
 * Works in Svelte 4 and 5 (plain stores + action, no runes). Changing a connect-critical
 * option (`url`, `token`, `imageOnly`, dpr, `maxBackingDimension`, `maxInflight`,
 * `autoResize`) via the action's `update` tears down and rebuilds the connection.
 */
export function createRemoteFramebuffer(initial: RfbSvelteOptions): RemoteFramebufferHandle {
  const state = writable<ConnectionState>("connecting");
  const stats = writable<Stats>(EMPTY_STATS);
  const error = writable<Error | null>(null);

  let view: RemoteFramebufferView | null = null;
  let node: HTMLElement | null = null;
  let opts: RfbSvelteOptions = initial;
  let key = "";

  function build(): void {
    if (!node) return;
    view?.dispose();
    error.set(null);
    view = new RemoteFramebufferView(node, {
      ...opts,
      onState: (s) => {
        state.set(s);
        opts.onState?.(s);
      },
      onStats: (s) => {
        stats.set(s);
        opts.onStats?.(s);
      },
      onError: (e) => {
        error.set(e);
        opts.onError?.(e);
      },
    });
    key = connectKey(opts);
  }

  const action: Action<HTMLElement, RfbSvelteOptions | undefined> = (el, params) => {
    node = el;
    if (params) opts = params;
    build();
    return {
      update(params?: RfbSvelteOptions) {
        if (params) opts = params;
        if (connectKey(opts) !== key) build();
      },
      destroy() {
        view?.dispose();
        view = null;
        node = null;
      },
    };
  };

  return {
    action,
    state: { subscribe: state.subscribe },
    stats: { subscribe: stats.subscribe },
    error: { subscribe: error.subscribe },
    capture: (format = "imagedata") =>
      view ? view.capture(format) : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
    reconnect: () => build(),
    view: () => view,
  };
}
