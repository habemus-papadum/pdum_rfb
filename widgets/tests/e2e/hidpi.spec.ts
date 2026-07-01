import { expect, test } from "@playwright/test";

// HiDPI regression guard. On a 2x display the browser sends *logical CSS*
// coordinates while its canvas backing store (and the physical pwidth/pheight)
// are 2x larger. The publisher maps logical -> framebuffer using the CSS size it
// learns from the `set_viewport` handshake. That handshake must be sent on
// connect -- the ResizeObserver's first callback is a no-op (size unchanged from
// construction), so without an explicit initial send the server never learns the
// CSS size and mis-scales every click by the device pixel ratio.
//
// This runs at deviceScaleFactor 2 (the default e2e project is 1, which is
// exactly why the original bug slipped through) and asserts the server received
// the initial viewport with the correct ratio and CSS-sized (not backing-sized)
// dimensions.
test.use({ deviceScaleFactor: 2 });

const WS = "ws://127.0.0.1:8770";
const HTTP = "http://127.0.0.1:8770";

interface RecordedEvent {
  type: string;
  width?: number;
  height?: number;
  pwidth?: number;
  pheight?: number;
  ratio?: number;
}

test("initial set_viewport handshake reaches the server at dpr=2", async ({ page, request }) => {
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

  // The viewport (a `resize` server-side, from the client's `set_viewport`) must
  // arrive without any explicit browser resize.
  await expect
    .poll(
      async () => {
        const events: RecordedEvent[] = await (await request.get(`${HTTP}/recorded-events`)).json();
        return events.some((e) => e.type === "resize");
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  const events: RecordedEvent[] = await (await request.get(`${HTTP}/recorded-events`)).json();
  const viewport = events.find((e) => e.type === "resize")!;

  // Ratio reflects the device pixel ratio...
  expect(viewport.ratio).toBe(2);
  // ...and width/height are CSS pixels, i.e. half the physical backing size.
  // (This is the coordinate space the publisher uses to scale logical clicks.)
  expect(viewport.pwidth).toBeGreaterThan(0);
  expect(viewport.width).toBeGreaterThan(0);
  expect(viewport.pwidth).toBeCloseTo((viewport.width as number) * 2, 0);
  expect(viewport.pheight).toBeCloseTo((viewport.height as number) * 2, 0);
});
