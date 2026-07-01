import { type Readable } from "svelte/store";
import type { Action } from "svelte/action";
import { RemoteFramebufferView, type ConnectionState, type Stats } from "@habemus-papadum/rfb-widgets";
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
/**
 * Headless Svelte primitive. Returns a `use:` action plus `state`/`stats`/`error` stores.
 * Works in Svelte 4 and 5 (plain stores + action, no runes). Changing a connect-critical
 * option (`url`, `token`, `imageOnly`, dpr, `maxBackingDimension`, `maxInflight`,
 * `autoResize`) via the action's `update` tears down and rebuilds the connection.
 */
export declare function createRemoteFramebuffer(initial: RfbSvelteOptions): RemoteFramebufferHandle;
