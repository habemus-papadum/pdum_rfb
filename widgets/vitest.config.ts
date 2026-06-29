import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/protocol.ts", "src/events.ts", "src/backpressure.ts", "src/capabilities.ts"],
    },
  },
});
