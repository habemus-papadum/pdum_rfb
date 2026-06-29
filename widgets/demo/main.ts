import { RemoteFramebufferView } from "../src/index";

const params = new URLSearchParams(location.search);
// Defaults to the `pdum.rfb.server` CLI default port; override with ?ws=...
const wsUrl = params.get("ws") ?? `ws://${location.hostname}:8765`;
const transport = params.get("transport") ?? "auto";

const stage = document.getElementById("stage") as HTMLElement;
const statsEl = document.getElementById("stats") as HTMLElement;

const view = new RemoteFramebufferView(stage, {
  url: wsUrl,
  imageOnly: transport === "image",
  onStats: (s) => {
    statsEl.textContent = JSON.stringify(s, null, 2);
  },
  onState: (st) => {
    statsEl.dataset.state = st;
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
