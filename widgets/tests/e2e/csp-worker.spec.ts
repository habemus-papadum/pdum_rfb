import { expect, test } from "@playwright/test";

import { type CapturedImage, matchedRotation, sampleQuadrant } from "../testPattern";

const WS = "ws://127.0.0.1:8770";

// Strict-CSP path: `?worker=external` builds the view with a `workerFactory` that
// constructs the worker from the packaged `dist/worker.js` URL (a real, cacheable
// module worker) instead of the default inlined `blob:` worker. This proves the
// shipped `@habemus-papadum/rfb-widgets/worker` subpath export actually decodes
// frames — the CSP-friendly alternative that needs no `worker-src blob:`.
test("packaged (non-blob) worker decodes the test pattern", async ({ page }) => {
  // Fail loudly if the worker tries to load from a blob: URL (it must not, under CSP).
  const workerUrls: string[] = [];
  page.on("worker", (w) => workerUrls.push(w.url()));

  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image&worker=external`);

  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: { stats(): { framesDisplayed: number } } }).__rfb;
      return !!r && r.stats().framesDisplayed > 2;
    },
    undefined,
    { timeout: 20_000 },
  );

  const cap = (await page.evaluate(() =>
    (window as unknown as { __rfb: { capture(): Promise<unknown> } }).__rfb.capture(),
  )) as CapturedImage & { lastDisplayedSeq: number };

  expect(cap.width).toBeGreaterThan(0);
  const quads = [0, 1, 2, 3].map((q) => sampleQuadrant(cap, q));
  expect(
    matchedRotation(cap, 24),
    `quadrants ${JSON.stringify(quads)} (seq ${cap.lastDisplayedSeq}) match no palette rotation`,
  ).toBeGreaterThanOrEqual(0);

  // The worker was loaded from a real asset URL, not a blob: — the whole point.
  expect(workerUrls.length).toBeGreaterThan(0);
  expect(workerUrls.some((u) => u.startsWith("blob:"))).toBe(false);
});
