// anywidget front-end module (AFM) for pdum.rfb. A single self-contained ESM (the Web
// Worker is inlined) that drives the core RemoteFramebufferView from `el`, reads connection
// + chrome traits off the model, and reacts to trait changes. Built by
// vite.anywidget.config.ts into ../src/pdum/rfb/static/widget.js (loaded as anywidget `_esm`).

import {
  MainThreadPresentView,
  RemoteFramebufferView,
  type ConnectionState,
  type Stats,
  type SurfacePreference,
} from "../src/index";
import { type AnyModel, mountChrome } from "./chrome";

// Either present controller — both expose the capture/dispose surface the chrome uses.
type Presenter = RemoteFramebufferView | MainThreadPresentView;

/** Build the WebSocket URL from the model traits. Priority: explicit `url` > same-origin
 *  `base_path` (remote/HTTPS, wss) > `host:port` (local, separate port). */
function resolveUrl(model: AnyModel): string {
  const explicit = model.get("url");
  if (explicit) return String(explicit);

  const stream = model.get("stream") || "default";
  const scheme = location.protocol === "https:" ? "wss" : "ws";

  const basePath = model.get("base_path");
  if (basePath) {
    // Same-origin: shares the page's TLS + cookie; no mixed-content under https.
    const path = String(basePath).replace(/\/+$/, "");
    return `${scheme}://${location.host}${path}/${stream}`;
  }

  let host = model.get("host");
  if (!host || host === "auto" || host === "0.0.0.0" || host === "::") {
    host = location.hostname || "127.0.0.1";
  }
  return `${scheme}://${host}:${model.get("port")}/${stream}`;
}

export default {
  render({ model, el }: { model: AnyModel; el: HTMLElement }) {
    el.classList.add("rfb-root");
    el.dataset.state = "connecting";
    const h = model.get("height");
    if (h) el.style.height = typeof h === "number" ? `${h}px` : String(h);

    // The view fills a dedicated surface; chrome overlays sit around it.
    const surface = document.createElement("div");
    surface.className = "rfb-viewport";
    el.appendChild(surface);

    let view: Presenter | null = null;
    let lastPush = 0;

    const controls = {
      capture: (fmt: "imagedata" | "blob") =>
        view ? view.capture(fmt) : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
      toggleTransport: () => {
        model.set("image_only", !model.get("image_only"));
        model.save_changes();
      },
      fullscreen: () => void el.requestFullscreen?.(),
      reconnect: () => build(),
      // Viewport / backend controls (client-side; drive the view directly, no model trait).
      // These are Mode A (RemoteFramebufferView) features; the main-thread present path
      // (MainThreadPresentView, the default for reparenting hosts like marimo) doesn't support
      // live backend-switch or zoom/pan, so they no-op there — see build() and docs/notebook.md.
      setSurface: (kind: SurfacePreference) => {
        if (view instanceof RemoteFramebufferView) view.setSurface(kind);
      },
      zoomIn: () => {
        if (view instanceof RemoteFramebufferView) view.zoomBy(1.25);
      },
      zoomOut: () => {
        if (view instanceof RemoteFramebufferView) view.zoomBy(1 / 1.25);
      },
      resetView: () => {
        if (view instanceof RemoteFramebufferView) view.resetView();
      },
      // Recording of what the viewer sees. Only the main-thread present path owns a real canvas
      // to captureStream(); the Mode-A path reports canRecord=false and the toggle disables.
      canRecord: () => !!view?.canRecord,
      isRecording: () => !!view?.isRecording,
      startRecording: () => view?.startRecording(),
      stopRecording: () =>
        view ? view.stopRecording() : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
    };
    const chrome = mountChrome(el, model, controls);

    // Push a small stats subset back to Python at ~1 Hz (optional observation); never
    // flood the comm at frame rate.
    function pushStats(s: Stats): void {
      const now = performance.now();
      if (now - lastPush < 1000) return;
      lastPush = now;
      model.set("stats", {
        transport: s.transport,
        framesDisplayed: s.framesDisplayed,
        framesDropped: s.framesDropped,
        decodeQueueSize: s.decodeQueueSize,
        serverFpsSent: s.serverFpsSent ?? null,
        serverRttMs: s.serverRttMs ?? null,
      });
      model.save_changes();
    }

    function build(): void {
      view?.dispose();
      el.dataset.state = "connecting";
      // Present path: default to the MAIN-THREAD path (a normal <canvas> drawn on receipt of
      // transferred frames) because it survives embedding hosts that reparent the widget subtree
      // after mount — notably marimo, where the OffscreenCanvas-transfer path (Mode A) renders a
      // black canvas even though the worker decodes correctly (docs/proposals/active/
      // marimo_rendering_fix.md). Set `main_thread_present=False` to force the lower-overhead
      // OffscreenCanvas transfer path (Mode A) where the host is known not to reparent.
      const mainThread = model.get("main_thread_present") !== false;
      const opts = {
        url: resolveUrl(model),
        token: model.get("token") || undefined,
        imageOnly: !!model.get("image_only"),
        fit: model.get("fit") || undefined,
        background: model.get("background") || undefined,
        onState: (s: ConnectionState) => {
          el.dataset.state = s;
          model.set("state", s);
          model.save_changes();
          chrome.setState(s);
        },
        onStats: (s: Stats) => {
          chrome.setStats(s);
          pushStats(s);
        },
        onError: (e: Error) => {
          model.set("last_error", e.message);
          model.save_changes();
          chrome.setError(e);
        },
      };
      // The main-thread present path (reparent-safe, for marimo) is a limited presenter; the
      // viewport/backend chrome features (surface switch, gestures, zoom/pan) are Mode A only,
      // so pass them solely to RemoteFramebufferView (which is where onViewport also gets its
      // proper ViewportFraming type).
      view = mainThread
        ? new MainThreadPresentView(surface, opts)
        : new RemoteFramebufferView(surface, {
            ...opts,
            surface: model.get("surface") || undefined,
            gestures: true, // batteries chrome: wheel-zoom, drag-pan, pinch
            onViewport: (framing) => chrome.setViewport(framing),
          });
      chrome.setError(null);
      chrome.refresh(); // sync record capability to the freshly built view (main-thread vs Mode A)
    }

    // Connect-time traits rebuild the view; chrome-only traits just toggle DOM.
    const onConnect = () => build();
    const onChrome = () => chrome.refresh();
    const connectTraits = [
      "url", "host", "base_path", "port", "stream", "token", "image_only", "fit", "background", "main_thread_present",
    ];
    for (const t of connectTraits) model.on(`change:${t}`, onConnect);
    model.on("change:show_toolbar", onChrome);
    model.on("change:show_stats", onChrome);

    build();

    // anywidget cleanup: tear down the view/worker/socket and detach everything.
    return () => {
      model.off(null, null);
      view?.dispose();
      view = null;
      chrome.destroy();
      surface.remove();
      el.classList.remove("rfb-root");
      delete el.dataset.state;
    };
  },
};
