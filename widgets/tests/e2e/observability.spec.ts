import { expect, test } from "@playwright/test";

// Agent-friendly observability (docs/agent_observable_web_workers.md, roadmap item 2). The
// worker's console.* is invisible to the Chrome MCP browser tools, so the decode worker forwards
// each log line to the main thread, where it lands in a bounded ring buffer on `window.__rfb.logs`
// and is re-consoled. These specs prove, in a real browser with a real Web Worker:
//   1. worker log lines reach `window.__rfb.logs` (notices by default; the verbose firehose gated);
//   2. `window.__rfb.setDebug(true)` flips the worker at runtime and unlocks the verbose stream —
//      no rebuild, no reload.

const WS = "ws://127.0.0.1:8770";

interface LogLine {
  level: string;
  tag: string;
  category: string;
  args: unknown[];
  t: number;
}
interface RfbRegistry {
  logs: LogLine[];
  state(): string;
  stats(): { framesDisplayed?: number } | undefined;
  setDebug(debug: boolean): void;
}
declare global {
  interface Window {
    __rfb: RfbRegistry;
  }
}

async function waitNegotiated(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => window.__rfb && window.__rfb.state() === "negotiated", undefined, {
    timeout: 20_000,
  });
}

test("worker log lines reach window.__rfb.logs (notices on by default; verbose gated off)", async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image`);
  await waitNegotiated(page);

  // The registry surface is installed by the view.
  expect(await page.evaluate(() => typeof window.__rfb.setDebug)).toBe("function");
  expect(await page.evaluate(() => Array.isArray(window.__rfb.logs))).toBe(true);

  // Forwarded worker lifecycle NOTICES land in the ring buffer (from the worker realm, tag
  // `rfb:worker`) — this is the stream a main-thread-only tool otherwise can't see.
  await expect
    .poll(
      () => page.evaluate(() => window.__rfb.logs.some((l) => l.tag === "rfb:worker" && l.category === "ws")),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(
    await page.evaluate(() => window.__rfb.logs.some((l) => l.tag === "rfb:worker" && l.category === "negotiated")),
  ).toBe(true);

  // …but the verbose per-frame `frame` firehose is gated off until debug is enabled.
  expect(await page.evaluate(() => window.__rfb.logs.some((l) => l.category === "frame"))).toBe(false);
});

test("window.__rfb.setDebug(true) toggles the worker at runtime and unlocks the verbose stream", async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image`);
  await waitNegotiated(page);

  // Confirm frames are flowing but no verbose lines yet.
  await expect
    .poll(() => page.evaluate(() => window.__rfb.stats()?.framesDisplayed ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__rfb.logs.some((l) => l.category === "frame"))).toBe(false);

  // Flip debug from the console handle — the productized form of the removed ad-hoc hooks.
  await page.evaluate(() => window.__rfb.setDebug(true));

  // The worker rebuilds its logger and starts forwarding per-frame `[rfb:worker] frame` lines,
  // which now appear in the ring buffer — no rebuild, no reload.
  await expect
    .poll(
      () => page.evaluate(() => window.__rfb.logs.some((l) => l.tag === "rfb:worker" && l.category === "frame")),
      { timeout: 15_000 },
    )
    .toBe(true);

  // Turning it back off stops new verbose lines (the count stabilizes).
  await page.evaluate(() => window.__rfb.setDebug(false));
  const afterOff = await page.evaluate(() => window.__rfb.logs.filter((l) => l.category === "frame").length);
  await page.waitForTimeout(500);
  const later = await page.evaluate(() => window.__rfb.logs.filter((l) => l.category === "frame").length);
  expect(later).toBe(afterOff);
});
