import { defineConfig } from "vite";

// Library build: React wrapper. Externalize React AND the core (peers) so consumers
// dedupe to one instance of each; the core already inlines its Web Worker, so we
// inherit it with zero worker config. `@habemus-papadum/rfb-ui` is private and bundled
// in (its pure helpers), while its rfb.css is copied to dist/styles.css by the build
// script (opt-in stylesheet, not auto-injected).
export default defineConfig({
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts files
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "@habemus-papadum/rfb-widgets"],
    },
  },
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
});
