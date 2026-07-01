import { defineConfig } from "vite";

// anywidget bundle build. Produces a SINGLE self-contained ESM (`widget.js`) with the
// core RemoteFramebufferView + its inlined Web Worker bundled in (nothing external —
// anywidget loads one `_esm` file). Output goes straight into the Python package data dir;
// the build script also copies rfb-ui's rfb.css to `widget.css` (loaded as anywidget `_css`).
export default defineConfig({
  build: {
    lib: {
      entry: "anywidget/entry.ts",
      formats: ["es"],
      fileName: () => "widget.js",
    },
    outDir: "../src/pdum/rfb/static",
    emptyOutDir: false, // dir holds only generated widget.* files; don't wipe anything else
    sourcemap: true,
    rollupOptions: { external: [] }, // bundle EVERYTHING
  },
  worker: { format: "es" }, // keep the inlined worker as ESM
});
