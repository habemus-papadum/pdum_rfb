import { writable } from "svelte/store";
import { RemoteFramebufferView } from "@habemus-papadum/rfb-widgets";
import { EMPTY_STATS } from "@habemus-papadum/rfb-ui";
const connectKey = (o) => JSON.stringify([o.url, o.token, o.imageOnly, o.devicePixelRatio, o.maxBackingDimension, o.maxInflight, o.autoResize]);
/**
 * Headless Svelte primitive. Returns a `use:` action plus `state`/`stats`/`error` stores.
 * Works in Svelte 4 and 5 (plain stores + action, no runes). Changing a connect-critical
 * option (`url`, `token`, `imageOnly`, dpr, `maxBackingDimension`, `maxInflight`,
 * `autoResize`) via the action's `update` tears down and rebuilds the connection.
 */
export function createRemoteFramebuffer(initial) {
    const state = writable("connecting");
    const stats = writable(EMPTY_STATS);
    const error = writable(null);
    let view = null;
    let node = null;
    let opts = initial;
    let key = "";
    function build() {
        if (!node)
            return;
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
    const action = (el, params) => {
        node = el;
        if (params)
            opts = params;
        build();
        return {
            update(params) {
                if (params)
                    opts = params;
                if (connectKey(opts) !== key)
                    build();
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
        capture: (format = "imagedata") => view ? view.capture(format) : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
        reconnect: () => build(),
        view: () => view,
    };
}
