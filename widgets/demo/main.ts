import { RemoteFramebufferView, type ConnectionState, type FitMode, type Stats } from "../src/index";

const params = new URLSearchParams(location.search);
// Defaults to the `pdum.rfb.server` CLI default port; override with ?ws=...
const wsUrl = params.get("ws") ?? `ws://${location.hostname}:8765`;
const transport = params.get("transport") ?? "auto";
const fit = (params.get("fit") as FitMode | null) ?? undefined;

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

const view = new RemoteFramebufferView(stage, {
  url: wsUrl,
  imageOnly: transport === "image",
  fit,
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
