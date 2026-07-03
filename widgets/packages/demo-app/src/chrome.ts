// The on-canvas "batteries" chrome toolbar for the demo viewport. This is the SAME toolbar the
// framework wrappers' <RemoteFramebuffer> and the anywidget chrome render — the capture / zoom /
// fit / backend controls, using the shared `rfb-ui` class contract (`.rfb-toolbar`, `.rfb-button`,
// `.rfb-select`, `.rfb-zoom`), icons, and `rfb.css` (imported once in main.ts). It's decoupled
// from the view internals — it drives the framework-agnostic `ViewerHandle` — so it renders
// identically under every framework path (Vanilla / React / Svelte / Solid). Mounted as an
// overlay child of the `.rfb-root` host, so it auto-hides until the viewport is hovered/focused
// (rfb.css `.rfb-root:hover .rfb-toolbar`).

import { formatZoom, SURFACE_CHOICES } from "@habemus-papadum/rfb-ui";
import type { SurfacePreference } from "@habemus-papadum/rfb-widgets";
import { el } from "./dom";

/** The actions the toolbar drives — thin adapters over the demo's `ViewerHandle` + shell. */
export interface ChromeActions {
  /** Capture the current frame as a PNG (the demo downloads it). */
  capture: () => void;
  fullscreen: () => void;
  /** Switch the display backend live (rebuilds the view + reconnects the stream). */
  setSurface: (kind: SurfacePreference) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Reset to the default fit (zoom 1, no pan). */
  resetView: () => void;
}

export interface DemoChrome {
  /** Reflect the live zoom in the readout (wire to the view's `onViewport`). */
  setZoom(zoom: number): void;
  /** Reflect the resolved backend (after any fallback) in the selector. */
  setSurface(kind: SurfacePreference): void;
  destroy(): void;
}

function button(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  return el("button", { type: "button", class: "rfb-button", title, text: icon, onclick: onClick }) as HTMLButtonElement;
}

/** Build the batteries chrome toolbar and append it over `host` (the `.rfb-root` element). */
export function mountDemoChrome(host: HTMLElement, actions: ChromeActions, surface: SurfacePreference): DemoChrome {
  const backendSel = el("select", {
    class: "rfb-select",
    title: "Display backend (rebuilds + reconnects)",
    onchange: (e: Event) => actions.setSurface((e.target as HTMLSelectElement).value as SurfacePreference),
  }) as HTMLSelectElement;
  for (const c of SURFACE_CHOICES) {
    const opt = el("option", { value: c.value, text: c.label, title: c.title }) as HTMLOptionElement;
    if (c.value === surface) opt.selected = true;
    backendSel.append(opt);
  }

  const zoomLabel = el("span", { class: "rfb-zoom", text: formatZoom(1) });

  const toolbar = el("div", { class: "rfb-toolbar", "data-pinned": "false" }, [
    button("📷", "Screenshot", actions.capture),
    button("⛶", "Fullscreen", actions.fullscreen),
    el("div", { class: "rfb-toolbar-sep" }),
    backendSel,
    button("−", "Zoom out", actions.zoomOut),
    zoomLabel,
    button("+", "Zoom in", actions.zoomIn),
    button("⤢", "Fit / reset view", actions.resetView),
  ]);
  host.append(toolbar);

  return {
    setZoom(zoom) {
      zoomLabel.textContent = formatZoom(zoom);
    },
    setSurface(kind) {
      if (backendSel.value !== kind) backendSel.value = kind;
    },
    destroy() {
      toolbar.remove();
    },
  };
}
