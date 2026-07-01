import { defineConfig } from "vitest/config";

// Tier-1 factory (stores + action) is plain TS, so the unit tests need no Svelte
// compiler — just a DOM. The .svelte component is thin glue over the tested factory.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
  },
});
