import { defineConfig } from "vite";

// Demo build: a production build of the demo page used by the Playwright e2e
// harness (via `vite preview`). Exercises the same inlined-worker path a real
// consumer would load.
export default defineConfig({
  build: {
    outDir: "dist/demo",
    emptyOutDir: true,
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
