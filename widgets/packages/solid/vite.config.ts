import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Library build: Solid wrapper. Externalize solid-js AND the core (peers). The core's
// Web Worker is already inlined, so it's inherited. rfb-ui's pure helpers bundle in;
// its rfb.css is copied to dist/styles.css by the build script (opt-in stylesheet).
export default defineConfig({
  plugins: [solid()],
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts files
    rollupOptions: {
      external: ["solid-js", "solid-js/web", "solid-js/store", "@habemus-papadum/rfb-widgets"],
    },
  },
});
