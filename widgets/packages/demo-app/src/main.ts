// The `pdum-rfb demo` SPA entry. Builds the shell (header · dark viewport · control rail),
// fetches capabilities + state from the REST control plane, mounts the framebuffer viewer
// under the chosen framework, and wires every control to a REST call. The Python side only
// serves this + logs.

import { formatStatsRows, statusLabel, statusTone } from "@habemus-papadum/rfb-ui";
import type { ConnectionState, Stats } from "@habemus-papadum/rfb-widgets";
import type { FitMode } from "@habemus-papadum/rfb-widgets";
import { api, wsUrl, type BackendCap, type Capabilities, type SceneCap, type StreamState } from "./api";
import { clear, el, field } from "./dom";
import { FRAMEWORKS, mountViewer, type Framework, type ViewerHandle } from "./viewer";
import "./styles.css";

const FITS: FitMode[] = ["contain", "cover", "fill"];

// --- app state --------------------------------------------------------------

let caps: Capabilities;
let streams: StreamState[] = [];
let currentName = "default";
let viewer: ViewerHandle | null = null;

const viewerOpts = {
  framework: "vanilla" as Framework,
  fit: "contain" as FitMode,
  debug:
    new URLSearchParams(location.search).get("debug") === "1" || localStorage.getItem("rfb-debug") === "1",
};

// --- persistent DOM (created once) -----------------------------------------

const viewportEl = el("div", { class: "viewport" });
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

function buildShell(): void {
  const app = document.getElementById("app")!;
  const head = el("header", { class: "demo__head" }, [
    el("h1", { class: "demo__title", html: 'pdum·rfb <small>demo</small>' }),
    el("span", { class: "demo__tagline", text: "render in Python, view in the browser" }),
    el("div", { class: "demo__spacer" }),
    pillEl,
  ]);
  const view = el("div", { class: "demo__view" }, [viewportEl]);
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
  app.append(el("div", { class: "demo" }, [head, view, rail]));
}

// --- viewer mount -----------------------------------------------------------

async function remountViewer(): Promise<void> {
  viewer?.dispose();
  viewer = null;
  clear(viewportEl);
  const st = current();
  viewer = await mountViewer(viewerOpts.framework, viewportEl, {
    url: wsUrl(st.name),
    fit: viewerOpts.fit,
    debug: viewerOpts.debug,
    onState: onViewerState,
    onStats: onViewerStats,
  });
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
  clear(statsDl);
  for (const [k, v] of formatStatsRows("negotiated", stats)) {
    if (k === "state") continue; // shown by the pill
    statsDl.append(el("dt", { text: k }), el("dd", { text: v }));
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

function qualityGroup(): HTMLElement {
  const st = current();
  const bitrate = el("input", { type: "text", value: st.bitrate_label }) as HTMLInputElement;
  const fps = el("input", { type: "number", value: String(st.fps), min: "1", max: "120" }) as HTMLInputElement;
  const width = el("input", { type: "number", value: String(st.width), min: "16" }) as HTMLInputElement;
  const height = el("input", { type: "number", value: String(st.height), min: "16" }) as HTMLInputElement;
  const colorOpts = ["srgb", "display-p3"].map((c) => ({ value: c, label: c }));
  return el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Quality" }),
    field("Bitrate", bitrate, "Target H.264/NVENC bitrate, e.g. 8M or 800k. Image modes ignore it."),
    field("FPS", fps, "Publish + encoder IDR-cadence target."),
    field(
      "Apply",
      el("div", { class: "btn-row" }, [
        el("button", {
          type: "button",
          class: "primary",
          text: "retune",
          onclick: () => void act(api.setQuality(st.name, { bitrate: bitrate.value, fps: Number(fps.value) })),
        }),
      ]),
    ),
    field("Size", el("div", { class: "btn-row" }, [width, el("span", { text: "×" }), height]), "Render size (even). Publishing a new size rebuilds encoders + keyframes. Under match_client the viewer drives it."),
    field(
      "Color",
      selectEl(colorOpts, st.color, (v) => void act(api.setParams(st.name, { color: v }))),
      "Tag the stream color space (P3 = Apple wide-gamut SDR).",
    ),
    el("div", { class: "btn-row" }, [
      el("button", {
        type: "button",
        text: "apply size",
        onclick: () => void act(api.setParams(st.name, { width: Number(width.value), height: Number(height.value) })),
      }),
    ]),
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
  return el("div", { class: "group" }, [
    el("div", { class: "group__title", text: "Viewer" }),
    field("Framework", frameworkSeg, "Which wrapper renders the viewer, live-swapped. Vanilla = the core view; React = the same view inside a React component."),
    field("Fit", fitSeg, "How the frame maps into the viewport when aspect ratios differ."),
    field("Debug", debugToggle, "Verbose client-side console logging (WS lifecycle, negotiation, keyframes, decode). Errors surface either way."),
    el("div", { class: "btn-row" }, [
      el("button", { type: "button", text: "capture PNG", onclick: () => void capture() }),
      el("button", { type: "button", text: "fullscreen", onclick: () => void viewportEl.requestFullscreen?.() }),
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
