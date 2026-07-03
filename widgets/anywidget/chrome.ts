// Vanilla-DOM "batteries" chrome for the anywidget widget (framework-agnostic — anywidget
// has no framework). Mirrors the tier-2 <RemoteFramebuffer> of the framework wrappers,
// reusing the shared rfb-ui formatters and the rfb.css class contract.

import { formatBadge, formatStatsRows, formatZoom, statusLabel, SURFACE_CHOICES } from "@habemus-papadum/rfb-ui";
import type { ConnectionState, Stats, SurfacePreference, ViewportFraming } from "../src/index";

/** The subset of the anywidget model the widget uses. */
export interface AnyModel {
  get(key: string): any;
  set(key: string, value: unknown): void;
  save_changes(): void;
  on(event: string, cb: () => void): void;
  off(event?: string | null, cb?: (() => void) | null): void;
}

export interface ChromeControls {
  capture: (fmt: "imagedata" | "blob") => Promise<ImageData | Blob>;
  toggleTransport: () => void;
  fullscreen: () => void;
  reconnect: () => void;
  /** Switch the display backend live (rebuilds the view + reconnects). */
  setSurface: (kind: SurfacePreference) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Reset to fit (zoom 1, no pan). */
  resetView: () => void;
}

export interface ChromeHandle {
  setState(s: ConnectionState): void;
  setStats(s: Stats): void;
  setError(e: Error | null): void;
  setViewport(framing: ViewportFraming): void;
  toggleHud(): void;
  refresh(): void;
  destroy(): void;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "rfb-button";
  b.title = title;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

export function mountChrome(el: HTMLElement, model: AnyModel, controls: ChromeControls): ChromeHandle {
  const status = document.createElement("div");
  status.className = "rfb-status";

  const badge = document.createElement("div");
  badge.className = "rfb-badge";
  badge.style.display = "none";

  const hud = document.createElement("pre");
  hud.className = "rfb-hud";
  hud.style.display = "none";

  const bannerMsg = document.createElement("span");
  const banner = document.createElement("div");
  banner.className = "rfb-banner";
  banner.setAttribute("role", "alert");
  banner.style.display = "none";
  banner.append(bannerMsg, button("↻", "Reconnect", () => controls.reconnect()));

  const loading = document.createElement("div");
  loading.className = "rfb-loading";
  loading.appendChild(Object.assign(document.createElement("div"), { className: "rfb-spinner" }));

  const hudBtn = button("📊", "Toggle stats", () => toggleHud());

  // Backend selector (2D / WebGL / WebGPU / Auto) — switching rebuilds the view (a canvas
  // context type is immutable) and reconnects the stream.
  const backendSel = document.createElement("select");
  backendSel.className = "rfb-select";
  backendSel.title = "Display backend (rebuilds + reconnects)";
  for (const c of SURFACE_CHOICES) {
    backendSel.append(Object.assign(document.createElement("option"), { value: c.value, textContent: c.label, title: c.title }));
  }
  backendSel.addEventListener("change", () => controls.setSurface(backendSel.value as SurfacePreference));

  // Zoom controls: out / readout / in / fit.
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "rfb-zoom";
  zoomLabel.textContent = formatZoom(1);

  const toolbar = document.createElement("div");
  toolbar.className = "rfb-toolbar";
  const sep = () => Object.assign(document.createElement("div"), { className: "rfb-toolbar-sep" });
  toolbar.append(
    hudBtn,
    button("⇄", "Toggle transport", () => controls.toggleTransport()),
    button("📷", "Screenshot", screenshot),
    button("⛶", "Fullscreen", () => controls.fullscreen()),
    sep(),
    backendSel,
    button("−", "Zoom out", () => controls.zoomOut()),
    zoomLabel,
    button("+", "Zoom in", () => controls.zoomIn()),
    button("⤢", "Fit / reset view", () => controls.resetView()),
  );

  el.append(status, badge, toolbar, hud, banner, loading);

  let hudOpen = false;
  let lastState: ConnectionState = "connecting";
  let lastStats: Stats | null = null;

  function screenshot(): void {
    controls.capture("blob").then((b) => {
      const url = URL.createObjectURL(b as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "framebuffer.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function toggleHud(): void {
    hudOpen = !hudOpen;
    renderHud();
  }

  function renderHud(): void {
    const visible = hudOpen && model.get("show_stats") !== false;
    hud.style.display = visible ? "" : "none";
    hudBtn.dataset.active = String(hudOpen);
    if (visible && lastStats) {
      hud.textContent = formatStatsRows(lastState, lastStats)
        .map(([k, v]) => `${k.padEnd(15)}${v}`)
        .join("\n");
    }
  }

  function refresh(): void {
    toolbar.style.display = model.get("show_toolbar") !== false ? "" : "none";
    if (model.get("show_stats") === false) hudOpen = false;
    renderHud();
  }

  refresh();

  return {
    setState(s) {
      lastState = s;
      status.textContent = statusLabel(s);
      renderHud();
    },
    setStats(s) {
      lastStats = s;
      if (s.transport !== "none") {
        badge.style.display = "";
        badge.textContent = formatBadge(s);
      }
      // Reflect the resolved backend (after any fallback) in the selector.
      if (s.surface && backendSel.value !== s.surface) backendSel.value = s.surface;
      if (s.framesDisplayed > 0) loading.style.display = "none";
      renderHud();
    },
    setViewport(framing) {
      zoomLabel.textContent = formatZoom(framing.zoom);
    },
    setError(e) {
      if (e) {
        bannerMsg.textContent = e.message;
        banner.style.display = "";
      } else {
        banner.style.display = "none";
      }
    },
    toggleHud,
    refresh,
    destroy() {
      for (const node of [status, badge, toolbar, hud, banner, loading]) node.remove();
    },
  };
}
