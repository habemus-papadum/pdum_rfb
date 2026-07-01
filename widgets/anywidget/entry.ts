// anywidget front-end module (AFM) for pdum.rfb. A single self-contained ESM (the Web
// Worker is inlined) that drives the core RemoteFramebufferView from `el`, reads connection
// + chrome traits off the model, and reacts to trait changes. Built by
// vite.anywidget.config.ts into ../src/pdum/rfb/static/widget.js (loaded as anywidget `_esm`).

import { RemoteFramebufferView, type ConnectionState, type Stats } from "../src/index";
import { type AnyModel, mountChrome } from "./chrome";

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

    let view: RemoteFramebufferView | null = null;
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
      view = new RemoteFramebufferView(surface, {
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
      });
      chrome.setError(null);
    }

    // Connect-time traits rebuild the view; chrome-only traits just toggle DOM.
    const onConnect = () => build();
    const onChrome = () => chrome.refresh();
    for (const t of ["url", "host", "base_path", "port", "stream", "token", "image_only", "fit", "background"]) {
      model.on(`change:${t}`, onConnect);
    }
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
