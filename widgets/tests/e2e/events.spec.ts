import { expect, test } from "@playwright/test";

const WS = "ws://127.0.0.1:8770";
const HTTP = "http://127.0.0.1:8770";

interface RecordedEvent {
  type: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  inside?: boolean;
  pixel_ratio?: number;
  code?: string;
  modifiers?: string[];
}

// Inject real input and assert the normalized events reach the Python server via
// its recorded-events HTTP side channel. Pointer/wheel coordinates are now *frame
// pixels* (mapped client-side through the viewport fit). The demo streams 640x480
// into a 640x480 stage at deviceScaleFactor 1, so `contain` is identity and the
// frame pixel equals the CSS coordinate — plus an `inside` flag and `pixel_ratio`.
test("pointer / key / wheel events round-trip to the server", async ({ page, request }) => {
  await request.get(`${HTTP}/recorded-events/reset`);
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image`);

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

  await page.mouse.move(box.x + 100, box.y + 50);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.wheel(0, -120);
  await canvas.focus();
  await page.keyboard.press("Shift+KeyA");

  await expect
    .poll(
      async () => {
        const events: RecordedEvent[] = await (await request.get(`${HTTP}/recorded-events`)).json();
        return events.map((e) => e.type);
      },
      { timeout: 10_000 },
    )
    .toContain("key_down");

  const events: RecordedEvent[] = await (await request.get(`${HTTP}/recorded-events`)).json();

  const move = events.find((e) => e.type === "pointer_move");
  expect(move, "a pointer_move event was recorded").toBeTruthy();
  expect(move?.x).toBe(100);
  expect(move?.y).toBe(50);
  // The frame-pixel contract adds an in-frame flag and the frame's render DPR echo.
  expect(move?.inside).toBe(true);
  expect(move?.pixel_ratio).toBe(1);

  const wheel = events.find((e) => e.type === "wheel");
  expect(wheel?.dy).toBe(-120);

  const key = events.find((e) => e.type === "key_down" && e.code === "KeyA");
  expect(key?.modifiers).toContain("Shift");
});
