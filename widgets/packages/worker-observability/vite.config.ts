import { defineConfig } from "vite";

// Minimal library build. Three self-contained ES modules — the DOM/WebWorker-neutral core
// (`index`), the worker-side bridge (`worker`), and the main-thread registry (`main`) — so the
// package can be consumed standalone if it ever moves out of this repo. In-repo consumers
// (the rfb widgets) import the TypeScript source directly via the package's `exports`, so this
// build is a self-contained-ness check, not a dependency of the widgets build.
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        worker: "src/worker.ts",
        main: "src/main.ts",
      },
      formats: ["es"],
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
  },
});
