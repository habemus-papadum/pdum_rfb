// e2e harness for client-side recording. Constructs a MainThreadPresentView (a real, on-screen
// <canvas>, unlike the OffscreenCanvas-transfer path) pointed at the Python test server, then
// exposes a tiny `window.__rec` control surface the spec drives: wait for frames, start
// recording, stop, and read back the resulting Blob's size/type. See
// tests/e2e/recording.spec.ts.

import { MainThreadPresentView, type RecordingOptions } from "../src/index";

const params = new URLSearchParams(location.search);
const wsUrl = params.get("ws") ?? `ws://${location.hostname}:8770/default`;
const imageOnly = params.get("transport") !== "video"; // default to the dependency-light image path

const el = document.getElementById("view") as HTMLElement;
const view = new MainThreadPresentView(el, { url: wsUrl, imageOnly });

(globalThis as unknown as { __rec: unknown }).__rec = {
  state: () => view.state,
  frames: () => view.stats.framesDisplayed,
  canRecord: () => view.canRecord,
  isRecording: () => view.isRecording,
  start: (opts?: RecordingOptions) => view.startRecording(opts),
  stop: async () => {
    const blob = await view.stopRecording();
    return { size: blob.size, type: blob.type };
  },
  dispose: () => view.dispose(),
};
