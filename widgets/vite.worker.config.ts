import { defineConfig } from "vite";

// Standalone worker build: bundles `src/worker/entry.ts` (and all its imports)
// into a single self-contained ES module at `dist/worker.js`, exposed via the
// `@habemus-papadum/rfb-widgets/worker` subpath export.
//
// This is the strict-CSP path: the default `?worker&inline` bundle constructs the
// worker from a `blob:` URL (needs `worker-src blob:`), whereas this file is a real,
// cacheable asset a consumer can load as a module worker under `worker-src 'self'`.
// It runs as a second `vite build` (own config) so it does not duplicate the worker
// code into `dist/index.js`.
export default defineConfig({
  build: {
    lib: {
      entry: "src/worker/entry.ts",
      formats: ["es"],
      fileName: () => "worker.js",
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep index.js + the tsc-emitted .d.ts files
  },
});
