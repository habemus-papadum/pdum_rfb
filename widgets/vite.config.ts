import { defineConfig } from "vite";

// Library build: the framework-agnostic RFB client. The worker is inlined via
// `?worker&inline` so the published bundle is self-contained for any consumer.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep tsc-emitted .d.ts files
  },
  worker: {
    format: "es",
  },
});
