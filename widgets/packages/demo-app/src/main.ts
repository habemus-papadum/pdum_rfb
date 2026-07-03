// The `pdum-rfb demo` SPA entry. Builds the shell (header · dark viewport · control rail),
// fetches capabilities + state from the REST control plane, mounts the framebuffer viewer
// under the chosen framework, and wires every control to a REST call. The Python side only
// serves this + logs.

import { formatStatsRows, statusLabel, statusTone, SURFACE_CHOICES, ZOOM_STEP } from "@habemus-papadum/rfb-ui";
import type { ConnectionState, Stats } from "@habemus-papadum/rfb-widgets";
import type { FitMode, SurfacePreference } from "@habemus-papadum/rfb-widgets";
import { api, wsUrl, type BackendCap, type Capabilities, type SceneCap, type StreamState } from "./api";
import { mountDemoChrome, type DemoChrome } from "./chrome";
import { clear, el, field } from "./dom";
import { createStatsOverlay, type StatsOverlay } from "./overlay";
import { FRAMEWORKS, mountViewer, type Framework, type ViewerHandle } from "./viewer";
// The shared batteries chrome stylesheet (`.rfb-toolbar` / `.rfb-button` / `.rfb-select` / …) —
// the SAME CSS the framework wrappers + anywidget use for the on-canvas toolbar.
import "@habemus-papadum/rfb-ui/rfb.css";
import "./styles.css";

const FITS: FitMode[] = ["contain", "cover", "fill"];

// --- app state --------------------------------------------------------------

let caps: Capabilities;
let streams: StreamState[] = [];
let currentName = "default";
let viewer: ViewerHandle | null = null;
let chrome: DemoChrome | null = null;

const viewerOpts = {
  framework: "vanilla" as Framework,
  fit: "contain" as FitMode,
  // Display backend (client-side draw path). Switched live via the core view's setSurface —
  // a canvas context type is immutable, so it rebuilds the view + reconnects the stream.
  surface: "2d" as SurfacePreference,
  debug:
    new URLSearchParams(location.search).get("debug") === "1" || localStorage.getItem("rfb-debug") === "1",
  // Stats overlay defaults ON; a stored "0" (user toggled off before) opts out.
  overlay: localStorage.getItem("rfb-overlay") !== "0",
};

// --- persistent DOM (created once) -----------------------------------------

const viewportEl = el("div", { class: "viewport" });
// The stats overlay is mounted on the `.demo__view` wrapper as a sibling of `viewportEl`, so it
// survives `remountViewer()` (which only clears `viewportEl`'s children). `viewEl` is that
// wrapper — we fullscreen IT (not just the viewport) so the overlay stays visible in fullscreen.
const overlay: StatsOverlay = createStatsOverlay();
let viewEl: HTMLElement;
const controlsEl = el("div", {});
const pillEl = el("span", { class: "pill", "data-tone": "connecting", text: "connecting" });
const clientsEl = el("dd", { text: "—" });
const statsDl = el("dl", { class: "stats" });
const errEl = el("div", { class: "err-line", style: "display:none" });

function current(): StreamState {
  return streams.find((s) => s.name === currentName) ?? streams[0];
}

// --- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  caps = await api.capabilities();
  streams = (await api.state()).streams;
  buildShell();
  await selectStream("default");
  setInterval(poll, 2500);
}

// The classic folded-ribbon "GitHub corner" (Tim Holman's octocat), themed to the demo's warm
// palette (ink triangle, surface octocat) and linking to the repo. Fixed top-right; the header
// gets extra right padding so the ● LIVE pill clears it.
const GITHUB_URL = "https://github.com/habemus-papadum/pdum_rfb";
function githubCorner(): HTMLElement {
  return el("a", {
    href: GITHUB_URL,
    class: "github-corner",
    target: "_blank",
    rel: "noopener",
    "aria-label": "View source on GitHub",
    html: `<svg width="72" height="72" viewBox="0 0 250 250" aria-hidden="true">
  <path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
  <path d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" class="octo-arm"></path>
  <path d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor" class="octo-body"></path>
</svg>`,
  });
}

function buildShell(): void {
  const app = document.getElementById("app")!;
  const head = el("header", { class: "demo__head" }, [
    el("h1", { class: "demo__title", html: 'pdum·rfb <small>demo</small>' }),
    el("span", { class: "demo__tagline", text: "render in Python, view in the browser" }),
    el("div", { class: "demo__spacer" }),
    pillEl,
  ]);
  viewEl = el("div", { class: "demo__view" }, [viewportEl, overlay.el]);
  const view = viewEl;
  overlay.setVisible(viewerOpts.overlay);
  const status = el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Session" }),
    (() => {
      const dl = el("dl", { class: "stats" }, [el("dt", { text: "viewers" }), clientsEl]);
      return dl;
    })(),
    statsDl,
    errEl,
  ]);
  const rail = el("aside", { class: "rail" }, [controlsEl, status]);
  clear(app);
  app.append(el("div", { class: "demo" }, [head, view, rail]), githubCorner());
}

// --- viewer mount -----------------------------------------------------------

async function remountViewer(): Promise<void> {
  viewer?.dispose();
  viewer = null;
  chrome?.destroy();
  chrome = null;
  clear(viewportEl);
  const st = current();

  // Host the batteries chrome: `.rfb-root` (the positioned, warm-themed shell from
  // styles.css) wraps the `.rfb-viewport` the view mounts into, plus the on-canvas toolbar
  // overlay (a sibling that auto-hides until the viewport is hovered). The view's canvas
  // lands inside `.rfb-viewport` under every framework path.
  const root = el("div", { class: "rfb-root" });
  const surface = el("div", { class: "rfb-viewport" });
  root.append(surface);
  viewportEl.append(root);

  viewer = await mountViewer(viewerOpts.framework, surface, {
    url: wsUrl(st.name),
    fit: viewerOpts.fit,
    surface: viewerOpts.surface,
    gestures: true, // wheel-zoom, middle/right-drag pan, pinch
    debug: viewerOpts.debug,
    onState: onViewerState,
    onStats: onViewerStats,
    onViewport: (framing) => chrome?.setZoom(framing.zoom), // keep the toolbar's zoom readout live
  });

  // The on-canvas capture / zoom / fit / backend toolbar — the same batteries chrome the
  // framework wrappers + anywidget present, driving the framework-agnostic ViewerHandle.
  chrome = mountDemoChrome(
    root,
    {
      capture: () => void capture(),
      fullscreen: () => void viewEl.requestFullscreen?.(),
      setSurface: (kind) => {
        viewerOpts.surface = kind;
        renderControls(); // keep the sidebar Backend segmented control in sync
        viewer?.setSurface(kind); // rebuild + reconnect (canvas context type is immutable)
      },
      zoomIn: () => viewer?.zoomBy(ZOOM_STEP),
      zoomOut: () => viewer?.zoomBy(1 / ZOOM_STEP),
      resetView: () => viewer?.preset("fit"),
    },
    viewerOpts.surface,
  );
}

async function selectStream(name: string): Promise<void> {
  if (!streams.some((s) => s.name === name)) name = "default";
  currentName = name;
  renderControls();
  await remountViewer();
}

function onViewerState(state: ConnectionState): void {
  pillEl.textContent = statusLabel(state);
  pillEl.setAttribute("data-tone", statusTone(state));
}

function onViewerStats(stats: Stats): void {
  overlay.update(stats);
  if (stats.surface) chrome?.setSurface(stats.surface); // reflect the resolved backend (post-fallback)
  clear(statsDl);
  for (const [k, v] of formatStatsRows("negotiated", stats)) {
    if (k === "state") continue; // shown by the pill
    statsDl.append(el("dt", { text: k }), el("dd", { text: v }));
  }
  // Decode-stall recoveries (client auto-healed a stalled decoder) — only once it happens.
  if (stats.recoveries) {
    statsDl.append(el("dt", { text: "recoveries" }), el("dd", { text: String(stats.recoveries) }));
  }
}

// --- control rail -----------------------------------------------------------

function renderControls(): void {
  clear(controlsEl);
  controlsEl.append(streamGroup(), sceneBackendGroup(), qualityGroup(), viewerGroup(), structuralGroup());
}

function selectEl(
  options: { value: string; label: string; disabled?: boolean; title?: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const sel = el("select", {
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
  }) as HTMLSelectElement;
  let matched = false;
  for (const o of options) {
    const opt = el("option", { value: o.value, text: o.label, disabled: o.disabled, title: o.title });
    if (o.value === value) {
      (opt as HTMLOptionElement).selected = true;
      matched = true;
    }
    sel.append(opt);
  }
  if (!matched) {
    // e.g. backend "auto:h264_cpu" before any explicit pick — show it as the current value.
    const opt = el("option", { value, text: value, selected: true });
    sel.insertBefore(opt, sel.firstChild);
  }
  return sel;
}

function segmented(
  options: { id: string; label: string; disabled?: boolean; title?: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  return el(
    "div",
    { class: "seg" },
    options.map((o) =>
      el("button", {
        type: "button",
        text: o.label,
        title: o.title,
        disabled: o.disabled,
        "aria-pressed": String(o.id === value),
        onclick: () => onChange(o.id),
      }),
    ),
  );
}

function streamGroup(): HTMLElement {
  const st = current();
  const opts = streams.map((s) => ({
    value: s.name,
    label: s.name === "default" ? "default · shared" : `${s.name} · private`,
  }));
  const selector = selectEl(opts, currentName, (v) => void selectStream(v));
  const buttons = el("div", { class: "btn-row" }, [
    el("button", { type: "button", text: "＋ private stream", onclick: () => void newPrivateStream() }),
  ]);
  if (st.private) {
    buttons.append(el("button", { type: "button", text: "destroy", onclick: () => void destroyStream(st.name) }));
  }
  return el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Stream" }),
    field("Stream", selector, "Shared 'default' fans one feed to every viewer; a private stream is yours alone (own scene/backend + the structural params below)."),
    buttons,
  ]);
}

function sceneBackendGroup(): HTMLElement {
  const st = current();
  const sceneOpts = caps.scenes.map((s: SceneCap) => ({
    value: s.key,
    label: s.available ? s.name : `${s.name} — unavailable`,
    disabled: !s.available,
    title: s.available ? s.description : s.reason,
  }));
  const backendOpts = caps.backends.map((b: BackendCap) => ({
    value: b.id,
    label: b.available ? b.label : `${b.label} — n/a`,
    disabled: !b.available,
    title: b.available ? "" : b.reason,
  }));
  const sceneSel = selectEl(sceneOpts, st.scene, (v) => void act(api.setScene(st.name, v)));
  sceneSel.dataset.testid = "scene";
  const backendSel = selectEl(backendOpts, st.backend, (v) => void act(api.setBackend(st.name, v)));
  backendSel.dataset.testid = "backend";
  return el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Scene & backend" }),
    field("Scene", sceneSel, "What the render loop publishes. Greyed scenes need absent hardware/deps."),
    field(
      "Backend",
      backendSel,
      "Live-switched on the same socket; the browser follows on the next keyframe. Greyed backends can't run here.",
    ),
  ]);
}

// Quality is discrete: pragmatic fixed choices that auto-apply on change (no retune/apply
// buttons — same live feel as scene/backend). The current stream value selects the option;
// `selectEl` surfaces any off-list value (e.g. a private stream created with custom params).
const BITRATE_OPTS = [
  { bits: 50_000, value: "50k", label: "50 kbps" },
  { bits: 250_000, value: "250k", label: "250 kbps" },
  { bits: 1_000_000, value: "1M", label: "1 Mbps" },
  { bits: 4_000_000, value: "4M", label: "4 Mbps" },
  { bits: 8_000_000, value: "8M", label: "8 Mbps" },
];
const FPS_OPTS = [10, 15, 30, 60];
// Deliberately mixed aspect ratios: with `contain` fit the letterboxing changes shape, so a
// size switch reads as a real resolution change (not just the bouncing box appearing to speed
// up). All dimensions even — the H.264/NVENC encoders require it.
const SIZE_OPTS = [
  { value: "1280x720", label: "1280 × 720 · 16:9" },
  { value: "1024x768", label: "1024 × 768 · 4:3" },
  { value: "720x720", label: "720 × 720 · 1:1" },
  { value: "540x960", label: "540 × 960 · 9:16" },
  { value: "1280x548", label: "1280 × 548 · 21:9" },
];

/** Nearest fixed bitrate option to the stream's current bits, so the dropdown reflects it. */
function nearestBitrate(bits: number): string {
  return BITRATE_OPTS.reduce((best, o) => (Math.abs(o.bits - bits) < Math.abs(best.bits - bits) ? o : best)).value;
}

function qualityGroup(): HTMLElement {
  const st = current();

  const bitrateSel = selectEl(
    BITRATE_OPTS.map((o) => ({ value: o.value, label: o.label })),
    nearestBitrate(st.bitrate),
    (v) => void act(api.setQuality(st.name, { bitrate: v })),
  );
  bitrateSel.dataset.testid = "bitrate";

  const fpsSel = selectEl(
    FPS_OPTS.map((f) => ({ value: String(f), label: `${f} fps` })),
    String(st.fps),
    (v) => void act(api.setQuality(st.name, { fps: Number(v) })),
  );
  fpsSel.dataset.testid = "fps";

  const sizeSel = selectEl(SIZE_OPTS, `${st.width}x${st.height}`, (v) => {
    const [w, h] = v.split("x").map(Number);
    void act(api.setParams(st.name, { width: w, height: h }));
  });
  sizeSel.dataset.testid = "size";

  const colorSel = selectEl(
    ["srgb", "display-p3"].map((c) => ({ value: c, label: c })),
    st.color,
    // A canvas's color space is fixed when its 2D context is created (before the first frame),
    // so a live switch can't mutate the running canvas — apply the param, then remount so the
    // fresh connection's `config` builds a new canvas in the chosen space.
    (v) => void act(api.setParams(st.name, { color: v })).then(remountViewer),
  );

  return el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Quality" }),
    field("Bitrate", bitrateSel, "Target H.264/NVENC bitrate. Image modes ignore it."),
    field("FPS", fpsSel, "Publish + encoder IDR-cadence target."),
    field("Size", sizeSel, "Render size. A new size rebuilds encoders + keyframes; under match_client the viewer drives it."),
    field("Color", colorSel, "Tag the stream color space (P3 = Apple wide-gamut SDR). Reconnects to apply."),
  ]);
}

function viewerGroup(): HTMLElement {
  const frameworkSeg = segmented(
    FRAMEWORKS.map((f) => ({ id: f.id, label: f.label })),
    viewerOpts.framework,
    (v) => {
      viewerOpts.framework = v as Framework;
      renderControls();
      void remountViewer();
    },
  );
  const fitSeg = segmented(
    FITS.map((f) => ({ id: f, label: f })),
    viewerOpts.fit,
    (v) => {
      viewerOpts.fit = v as FitMode;
      renderControls();
      viewer?.setFit(viewerOpts.fit); // live, no reconnect
    },
  );
  // Backend switch — the batteries "switch display methodology" control. A canvas context
  // type is immutable, so setSurface rebuilds the view + reconnects (a brief flash).
  const backendSeg = segmented(
    SURFACE_CHOICES.map((c) => ({ id: c.value, label: c.label, title: c.title })),
    viewerOpts.surface,
    (v) => {
      viewerOpts.surface = v as SurfacePreference;
      renderControls();
      viewer?.setSurface(viewerOpts.surface); // rebuild + reconnect
    },
  );
  const zoomRow = el("div", { class: "btn-row" }, [
    el("button", { type: "button", text: "－", title: "Zoom out", onclick: () => viewer?.zoomBy(1 / 1.25) }),
    el("button", { type: "button", text: "1:1", title: "Native pixels", onclick: () => viewer?.preset("one-to-one") }),
    el("button", { type: "button", text: "fit", title: "Reset to fit", onclick: () => viewer?.preset("fit") }),
    el("button", { type: "button", text: "＋", title: "Zoom in", onclick: () => viewer?.zoomBy(1.25) }),
  ]);
  const debugToggle = el("label", { class: "toggle" }, [
    (() => {
      const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
      cb.dataset.testid = "debug";
      cb.checked = viewerOpts.debug;
      cb.addEventListener("change", () => {
        viewerOpts.debug = cb.checked;
        localStorage.setItem("rfb-debug", cb.checked ? "1" : "0");
        void remountViewer(); // debug is a worker-init option
      });
      return cb;
    })(),
    el("span", { text: "console logging" }),
  ]);
  const overlayToggle = el("label", { class: "toggle" }, [
    (() => {
      const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
      cb.dataset.testid = "overlay";
      cb.checked = viewerOpts.overlay;
      cb.addEventListener("change", () => {
        viewerOpts.overlay = cb.checked;
        localStorage.setItem("rfb-overlay", cb.checked ? "1" : "0");
        overlay.setVisible(cb.checked); // live, no reconnect
      });
      return cb;
    })(),
    el("span", { text: "on-canvas stats" }),
  ]);
  return el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Viewer" }),
    field("Framework", frameworkSeg, "Which wrapper renders the viewer, live-swapped. Vanilla = the core view; React = the same view inside a React component."),
    field("Fit", fitSeg, "How the frame maps into the viewport when aspect ratios differ."),
    field("Backend", backendSeg, "Client draw path (Canvas2D / WebGL2 / WebGPU / auto). A canvas context type is immutable, so switching rebuilds the view + reconnects the stream."),
    field("Zoom", zoomRow, "Client-side crop/zoom/pan (no server render). Also: wheel to zoom, middle/right-drag to pan, pinch on touch."),
    field("Debug", debugToggle, "Verbose client-side console logging (WS lifecycle, negotiation, keyframes, decode). Errors surface either way."),
    field("Overlay", overlayToggle, "Toggle the on-canvas stats overlay (fps · rtt · measured bitrate + sparklines), pinned to the viewport's bottom-left corner."),
    el("div", { class: "btn-row" }, [
      el("button", { type: "button", text: "capture PNG", onclick: () => void capture() }),
      el("button", { type: "button", text: "fullscreen", onclick: () => void viewEl.requestFullscreen?.() }),
      el("button", { type: "button", text: "reconnect", onclick: () => void remountViewer() }),
    ]),
  ]);
}

function structuralGroup(): HTMLElement {
  const st = current();
  const rows: [string, string][] = [
    ["adaptive", st.adaptive ? "on" : "off"],
    ["still after", st.still_after == null ? "off" : `${st.still_after}s`],
    ["stats interval", st.stats_interval == null ? "off" : `${st.stats_interval}s`],
    ["pipeline depth", String(st.encode_pipeline_depth)],
    ["resize policy", st.resize_policy],
  ];
  const dl = el("dl", { class: "stats" });
  for (const [k, v] of rows) dl.append(el("dt", { text: k }), el("dd", { text: v }));
  return el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Structural (per-stream)" }),
    dl,
    el("div", { class: "note", text: "Set once at stream birth — create a private stream to explore them." }),
  ]);
}

// --- actions ----------------------------------------------------------------

async function act(p: Promise<StreamState>): Promise<void> {
  try {
    const updated = await p;
    streams = streams.map((s) => (s.name === updated.name ? updated : s));
    renderControls();
    updateSession();
  } catch (e) {
    showError(String(e));
  }
}

async function newPrivateStream(): Promise<void> {
  const body = promptPrivate();
  if (!body) return;
  try {
    const created = await api.createStream(body);
    streams = (await api.state()).streams;
    await selectStream(created.name);
  } catch (e) {
    showError(String(e));
  }
}

function promptPrivate(): Record<string, unknown> | null {
  // A quiet inline prompt is enough for a dev demo; the structural knobs are simple.
  const adaptive = confirm("Enable adaptive quality on the new private stream? (Cancel = off)");
  const still = prompt("Still-after-settle seconds (blank = off):", "");
  const depth = prompt("Encoder pipeline depth (0 = synchronous):", "0");
  return {
    adaptive,
    still_after: still?.trim() ? Number(still) : null,
    encode_pipeline_depth: depth?.trim() ? Number(depth) : 0,
    stats_interval: 1.0,
  };
}

async function destroyStream(name: string): Promise<void> {
  try {
    await api.deleteStream(name);
    streams = (await api.state()).streams;
    await selectStream("default");
  } catch (e) {
    showError(String(e));
  }
}

async function capture(): Promise<void> {
  if (!viewer) return;
  const blob = await viewer.capture();
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `${currentName}.png` }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateSession(): void {
  const st = current();
  clientsEl.textContent = String(st.clients);
  if (st.last_error) showError(st.last_error);
  else errEl.style.display = "none";
}

function showError(msg: string): void {
  errEl.textContent = msg;
  errEl.style.display = "";
}

async function poll(): Promise<void> {
  try {
    const next = (await api.state()).streams;
    const namesChanged = next.map((s) => s.name).join() !== streams.map((s) => s.name).join();
    streams = next;
    updateSession();
    if (namesChanged) renderControls();
  } catch {
    /* transient; the next tick retries */
  }
}

boot().catch((e) => {
  document.getElementById("app")!.textContent = `Failed to start demo: ${e}`;
});
