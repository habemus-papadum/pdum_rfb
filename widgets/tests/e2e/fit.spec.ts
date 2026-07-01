import { expect, test } from "@playwright/test";
import { backingToFrame, type FitMode } from "../../src/viewport";

// The matrix that would have caught the original HiDPI coordinate bug: for each
// deviceScaleFactor x fit mode, inject a click at a known CSS point and assert the
// server recorded the *frame pixel* our shared geometry (backingToFrame, the same
// code the worker runs) predicts. The demo streams 640x480 into a deliberately
// square 480x480 stage (?stage=480x480), so contain letterboxes and cover crops —
// the fit actually changes the answer, and the two modes are distinguishable.

const WS = "ws://127.0.0.1:8770";
const HTTP = "http://127.0.0.1:8770";

const STREAM_W = 640;
const STREAM_H = 480;
const STAGE = 480; // square CSS box
const CLICK_CSS = { x: 120, y: 240 }; // off-center so contain != cover

interface RecordedEvent {
  type: string;
  x?: number;
  y?: number;
  inside?: boolean;
}

for (const dpr of [1, 2]) {
  test.describe(`deviceScaleFactor=${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    for (const fit of ["contain", "cover"] as FitMode[]) {
      test(`fit=${fit} maps a click to the predicted frame pixel`, async ({ page, request }) => {
        await request.get(`${HTTP}/recorded-events/reset`);
        await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image&fit=${fit}&stage=${STAGE}x${STAGE}`);

        await page.waitForFunction(
          () => {
            const r = (window as unknown as { __rfb?: { state(): string } }).__rfb;
            return !!r && r.state() === "negotiated";
          },
          undefined,
          { timeout: 20_000 },
        );

        const canvas = page.locator("#stage canvas");
        const box = await canvas.boundingBox();
        if (!box) throw new Error("canvas has no bounding box");

        // Drag so a pointer_move (which paints / records) fires at the target point.
        await page.mouse.move(box.x + CLICK_CSS.x, box.y + CLICK_CSS.y);
        await page.mouse.down();
        await page.mouse.move(box.x + CLICK_CSS.x, box.y + CLICK_CSS.y);
        await page.mouse.up();

        await expect
          .poll(async () => {
            const events: RecordedEvent[] = await (await request.get(`${HTTP}/recorded-events`)).json();
            return events.some((e) => e.type === "pointer_move");
          }, { timeout: 10_000 })
          .toBe(true);

        const events: RecordedEvent[] = await (await request.get(`${HTTP}/recorded-events`)).json();
        const move = events.find((e) => e.type === "pointer_move")!;

        // The worker maps CSS -> backing (x DPR) -> frame; mirror it here.
        const expected = backingToFrame(
          { frameW: STREAM_W, frameH: STREAM_H, backingW: STAGE * dpr, backingH: STAGE * dpr, fit },
          CLICK_CSS.x * dpr,
          CLICK_CSS.y * dpr,
        );
        expect(move.x).toBeCloseTo(expected.x, 0);
        expect(move.y).toBeCloseTo(expected.y, 0);
        expect(move.inside).toBe(expected.inside);
      });
    }
  });
}
