import { expect, test } from "@playwright/test";

// The client logger has three tiers (see src/debug.ts):
//   error()  — always on
//   notice() — lifecycle events (WS/negotiation/keyframe/resize); ON by default
//   log()    — verbose per-frame play-by-play; OFF unless `debug` (?debug=1)
// These specs assert that ?debug=1 adds the verbose stream on top of the always-on notices,
// and that without the flag the notices still show but the per-frame firehose does not.

const WS = "ws://127.0.0.1:8770";

async function collectRfbLogs(page: import("@playwright/test").Page): Promise<string[]> {
  const logs: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[rfb:")) logs.push(text);
  });
  return logs;
}

async function waitNegotiated(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: { state(): string } }).__rfb;
      return !!r && r.state() === "negotiated";
    },
    undefined,
    { timeout: 20_000 },
  );
}

test("?debug=1 emits verbose per-frame logs on top of the notices", async ({ page }) => {
  const logs = await collectRfbLogs(page);
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image&debug=1`);
  await waitNegotiated(page);

  // Notices (on regardless) + the verbose stream the flag unlocks.
  await expect.poll(() => logs.some((l) => l.includes("[rfb:worker] negotiated")), { timeout: 10_000 }).toBe(true);
  expect(logs.some((l) => l.includes("[rfb:worker] ws"))).toBe(true);
  // Per-frame `log()` lines only appear with debug on.
  await expect.poll(() => logs.some((l) => l.includes("[rfb:worker] frame")), { timeout: 10_000 }).toBe(true);
  expect(logs.some((l) => l.includes("[rfb:view] state"))).toBe(true);
});

test("notices show by default; the per-frame firehose stays off", async ({ page }) => {
  const logs = await collectRfbLogs(page);
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image`);
  await waitNegotiated(page);

  // Lifecycle notices are on by default (WS + negotiation).
  await expect.poll(() => logs.some((l) => l.includes("[rfb:worker] negotiated")), { timeout: 10_000 }).toBe(true);
  expect(logs.some((l) => l.includes("[rfb:worker] ws"))).toBe(true);
  // ...but the verbose per-frame `log()` stream (frame decode, view state) is gated off.
  expect(logs.filter((l) => l.includes("[rfb:worker] frame") || l.includes("[rfb:view] state"))).toHaveLength(0);
});
