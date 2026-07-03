import { defineConfig } from "vite";

// Demo build: a production build of the demo page used by the Playwright e2e
// harness (via `vite preview`). Exercises the same inlined-worker path a real
// consumer would load.
export default defineConfig({
  build: {
    outDir: "dist/demo",
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page: the demo + the anywidget e2e harness + the display-surface conformance
      // harness + the draw-path benchmark harness + the recording harness.
      input: {
        index: "index.html",
        anywidget: "anywidget-harness.html",
        surfaceHarness: "surface-harness.html",
        feedHarness: "feed-harness.html",
        benchHarness: "bench-harness.html",
        recordHarness: "record-harness.html",
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
  },
  worker: {
    format: "es",
  },
});
