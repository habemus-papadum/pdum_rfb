import {
  RemoteFramebufferView,
  type ConnectionState,
  type FitMode,
  type Stats,
  type SurfaceKind,
  type SurfacePreference,
} from "../src/index";
// The shipped, self-contained worker asset (the `@habemus-papadum/rfb-widgets/worker`
// subpath export). `?url` makes Vite emit it as a real, cacheable file and hand us its
// URL — the strict-CSP path (`worker-src 'self'`, no `blob:`). `?worker=external`
// selects it so the e2e proves the packaged worker decodes.
import packagedWorkerUrl from "../dist/worker.js?url";

const params = new URLSearchParams(location.search);
// Defaults to the `pdum.rfb.server` CLI default port; override with ?ws=...
const wsUrl = params.get("ws") ?? `ws://${location.hostname}:8765`;
const transport = params.get("transport") ?? "auto";
const fit = (params.get("fit") as FitMode | null) ?? undefined;
// ?surface=2d|webgl|webgpu|auto selects the compositing backend (default 2d); the e2e
// conformance spec drives this to prove each backend produces the same pixels.
const surface = (params.get("surface") as SurfacePreference | null) ?? undefined;
const debug = params.get("debug") === "1";
// `?worker=external` → construct the worker from the packaged `dist/worker.js` URL
// (a non-`blob:` module worker) instead of the default inlined `blob:` worker.
const externalWorker = params.get("worker") === "external";

const stage = document.getElementById("stage") as HTMLElement;
const statsEl = document.getElementById("stats") as HTMLElement;

// The e2e fit matrix drives a deliberate aspect-ratio mismatch by resizing the stage
// (the stream stays 640x480); ?stage=WxH overrides the CSS box for those specs.
const stageParam = params.get("stage");
if (stageParam) {
  const [sw, sh] = stageParam.split("x").map(Number);
  if (sw > 0 && sh > 0) {
    stage.style.width = `${sw}px`;
    stage.style.height = `${sh}px`;
  }
}

// A small live HUD built entirely from `onStats` — the worked example in
// docs/metrics_adaptive.md. The `server*` / `target*` rows show "—" until the
// server is started with `--stats-interval` (and/or `--adaptive`).
const mbps = (bps?: number) => (bps === undefined ? "—" : `${(bps / 1e6).toFixed(1)} Mbps`);
const ms = (v?: number) => (v === undefined ? "—" : `${v.toFixed(0)} ms`);
const n1 = (v?: number) => (v === undefined ? "—" : v.toFixed(1));

let connState: ConnectionState = "connecting";

function renderHud(s: Stats): void {
  const rows: [string, string][] = [
    ["state", connState],
    ["transport", s.transport],
    ["displayed", `${s.framesDisplayed} (dropped ${s.framesDropped})`],
    ["decode queue", String(s.decodeQueueSize)],
    ["rtt", ms(s.serverRttMs)],
    ["server fps", n1(s.serverFpsSent)],
    ["server bitrate", mbps(s.serverBitrateBps)],
    ["encode", ms(s.serverEncodeMs)],
    ["target bitrate", mbps(s.targetBitrate)],
    ["target fps", n1(s.targetFps)],
  ];
  statsEl.textContent = rows.map(([k, v]) => `${k.padEnd(15)}${v}`).join("\n");
}

// ?gestures=1 turns on wheel-zoom / drag-pan / pinch for manual poking; the e2e drives the
// transform via the imperative __rfb hooks below instead (deterministic).
const gestures = params.get("gestures") === "1";

const view = new RemoteFramebufferView(stage, {
  url: wsUrl,
  imageOnly: transport === "image",
  fit,
  surface,
  gestures,
  debug,
  workerFactory: externalWorker ? () => new Worker(packagedWorkerUrl, { type: "module" }) : undefined,
  onStats: renderHud,
  onState: (st) => {
    connState = st;
    statsEl.dataset.state = st;
    renderHud(view.stats);
  },
});

// Debug hooks consumed by the Playwright e2e tests.
interface RfbDebug {
  state: () => string;
  stats: () => unknown;
  surface: () => SurfaceKind | undefined;
  setSurface: (kind: SurfacePreference) => void;
  setViewport: (partial: { fit?: FitMode; zoom?: number; panX?: number; panY?: number }) => void;
  getViewport: () => unknown;
  zoomBy: (factor: number, cssX?: number, cssY?: number) => void;
  capture: () => Promise<{
    width: number;
    height: number;
    data: number[];
    lastDisplayedSeq: number;
  }>;
}
(globalThis as unknown as { __rfb: RfbDebug }).__rfb = {
  state: () => view.state,
  stats: () => view.stats,
  surface: () => view.surface,
  setSurface: (kind) => view.setSurface(kind),
  setViewport: (partial) => view.setViewport(partial),
  getViewport: () => view.getViewport(),
  zoomBy: (factor, cssX, cssY) => view.zoomBy(factor, cssX, cssY),
  capture: async () => {
    const img = (await view.capture("imagedata")) as ImageData;
    return {
      width: img.width,
      height: img.height,
      data: Array.from(img.data),
      lastDisplayedSeq: view.lastCaptureSeq,
    };
  },
};
