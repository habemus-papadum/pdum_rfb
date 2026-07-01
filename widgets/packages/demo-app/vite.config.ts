import { resolve } from "node:path";
import { defineConfig } from "vite";

// The `pdum-rfb demo` SPA. Builds a minified, self-contained bundle straight into the
// Python package's static dir so it ships as committed package data (like widget.js) and
// `uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb demo` needs no Node. `base: "./"` keeps
// asset URLs relative so Starlette's StaticFiles can serve it from `/`.
//
// In `pdum-rfb demo --dev`, this same project runs as a Vite dev server (TS HMR) and proxies
// the REST + framebuffer WS to the Python process, whose origin is passed via RFB_DEMO_API.
const api = process.env.RFB_DEMO_API; // e.g. "http://127.0.0.1:53187" (set by --dev)

export default defineConfig({
  base: "./",
  server: api
    ? {
        proxy: {
          "/demo": { target: api, changeOrigin: true },
          "/streams": { target: api, changeOrigin: true },
          "/rfb": { target: api.replace(/^http/, "ws"), ws: true },
        },
      }
    : undefined,
  // React is used via `createElement` (no JSX in our code); esbuild's automatic runtime
  // still lets the bundled component tree resolve `react/jsx-runtime` cleanly.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  build: {
    outDir: resolve(__dirname, "../../../src/pdum/rfb/static/demo"),
    emptyOutDir: true,
    // Committed package data: no sourcemaps, stable (unhashed) names so rebuilds produce
    // clean git diffs (content changes, not renamed files). StaticFiles serves whatever
    // index.html references.
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
