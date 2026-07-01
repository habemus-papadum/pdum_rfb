import { expect, test } from "@playwright/test";

// The `debug` option (RfbViewOptions -> worker init) turns on the verbose client-side
// console stream. With ?debug=1 the demo page passes it through; we assert the tagged
// `[rfb:...]` lines show up (WS lifecycle + negotiation), and that they are ABSENT
// without the flag (the library is quiet by default).

const WS = "ws://127.0.0.1:8770";

async function collectRfbLogs(page: import("@playwright/test").Page): Promise<string[]> {
  const logs: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[rfb:")) logs.push(text);
  });
  return logs;
}

test("?debug=1 emits the tagged console play-by-play", async ({ page }) => {
  const logs = await collectRfbLogs(page);
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image&debug=1`);

  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: { state(): string } }).__rfb;
      return !!r && r.state() === "negotiated";
    },
    undefined,
    { timeout: 20_000 },
  );

  // Give a couple of frames' worth of logs time to flush.
  await expect.poll(() => logs.some((l) => l.includes("[rfb:worker] config")), { timeout: 10_000 }).toBe(true);
  expect(logs.some((l) => l.includes("[rfb:worker] ws"))).toBe(true);
  expect(logs.some((l) => l.includes("[rfb:view] state"))).toBe(true);
});

test("without the flag the client stays quiet", async ({ page }) => {
  const logs = await collectRfbLogs(page);
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image`);

  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: { state(): string } }).__rfb;
      return !!r && r.state() === "negotiated";
    },
    undefined,
    { timeout: 20_000 },
  );

  // Verbose `log()` lines are gated off; only genuine errors could appear (none expected).
  expect(logs.filter((l) => l.includes("[rfb:worker] config") || l.includes("[rfb:worker] frame"))).toHaveLength(0);
});
