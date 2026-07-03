import { defineConfig } from "vitest/config";

// Unit tests run in Node — the library references no DOM/WebWorker globals at module load
// (console/clock/timer/target are all injectable), so the ring buffer, registry, and bridge
// round-trip are exercised without a browser env.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
