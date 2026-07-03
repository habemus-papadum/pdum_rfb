// e2e harness: exercise the REAL anywidget front-end module (../anywidget/entry) with a
// minimal stub of the anywidget `model`, pointing it at the booted Python test server.
// No Jupyter required — this validates the render()/traits/cleanup contract headlessly.

import widget from "../anywidget/entry";

const params = new URLSearchParams(location.search);
const wsUrl = params.get("ws") ?? `ws://${location.hostname}:8770/default`;
const imageOnly = params.get("transport") === "image";
// present=main (default) drives the main-thread present path; present=offscreen forces the
// Mode-A OffscreenCanvas-transfer path. Lets the spec exercise both.
const mainThreadPresent = params.get("present") !== "offscreen";

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
  main_thread_present: mainThreadPresent,
  height: 480,
  show_toolbar: true,
  show_stats: true,
  state: "connecting",
  stats: {},
  last_error: "",
});

const cleanup = widget.render({ model, el });

/** Read the on-screen MAIN-THREAD canvas back via getImageData — the composited-surface ground
 *  truth (§7.4 of the marimo proposal). Returns null on the Mode-A path, where the canvas is
 *  transferred to the worker and `getContext` throws — proving the two paths are distinguishable. */
function mainCanvasCapture(): { width: number; height: number; data: number[] } | null {
  const canvas = el.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas || !canvas.width || !canvas.height) return null;
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return null; // transferred to the worker (Mode A) — unreadable from the main thread
  }
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: Array.from(img.data) };
}

/** Simulate an embedding host (marimo) detaching + re-attaching the widget subtree after mount —
 *  the reparent that severs an OffscreenCanvas placeholder from the compositor. */
function reparent(): void {
  const original = el.parentElement;
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  holder.appendChild(el); // detach from the original parent, attach under a fresh one
  if (original) original.appendChild(el); // move back where it was
}

// Debug hooks consumed by tests/e2e/anywidget*.spec.ts (mirrors demo/main.ts __rfb). The view
// mounted by the anywidget already installed the observability registry at `window.__rfb`
// (`.logs`, `.setDebug`, `.instances`); DECORATE it with these harness hooks rather than
// replacing it, so both surfaces coexist.
const g = globalThis as unknown as { __rfb?: Record<string, unknown> };
g.__rfb = Object.assign(g.__rfb ?? {}, {
  state: () => model.get("state"),
  stats: () => model.get("stats"),
  lastError: () => model.get("last_error"),
  hasCanvas: () => !!el.querySelector("canvas"),
  mainCanvasCapture,
  reparent,
  cleanup,
});
