// e2e harness: exercise the REAL anywidget front-end module (../anywidget/entry) with a
// minimal stub of the anywidget `model`, pointing it at the booted Python test server.
// No Jupyter required — this validates the render()/traits/cleanup contract headlessly.

import widget from "../anywidget/entry";

const params = new URLSearchParams(location.search);
const wsUrl = params.get("ws") ?? `ws://${location.hostname}:8770/default`;
const imageOnly = params.get("transport") === "image";

/** Minimal anywidget model: get/set/save_changes/on/off over a plain map. */
function makeModel(initial: Record<string, unknown>) {
  const data = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (k: string) => data.get(k),
    set: (k: string, v: unknown) => {
      data.set(k, v);
      listeners.get(`change:${k}`)?.forEach((cb) => cb());
    },
    save_changes: () => {},
    on: (e: string, cb: () => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(cb);
    },
    off: (e?: string | null, cb?: (() => void) | null) => {
      if (e == null) listeners.clear();
      else if (cb) listeners.get(e)?.delete(cb);
      else listeners.delete(e);
    },
  };
}

const el = document.getElementById("widget") as HTMLElement;
const model = makeModel({
  url: wsUrl,
  host: "auto",
  base_path: "",
  port: 8770,
  stream: "default",
  token: "",
  image_only: imageOnly,
  height: 480,
  show_toolbar: true,
  show_stats: true,
  state: "connecting",
  stats: {},
  last_error: "",
});

const cleanup = widget.render({ model, el });

// Debug hooks consumed by tests/e2e/anywidget.spec.ts (mirrors demo/main.ts __rfb).
(globalThis as unknown as { __rfb: unknown }).__rfb = {
  state: () => model.get("state"),
  stats: () => model.get("stats"),
  lastError: () => model.get("last_error"),
  hasCanvas: () => !!el.querySelector("canvas"),
  cleanup,
};
