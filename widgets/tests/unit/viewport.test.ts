import { describe, expect, it } from "vitest";
import { backingToFrame, fitScales, frameDestRect, type ViewportState } from "../../src/viewport";

const state = (over: Partial<ViewportState>): ViewportState => ({
  frameW: 1280,
  frameH: 720,
  backingW: 1280,
  backingH: 720,
  fit: "contain",
  ...over,
});

describe("frameDestRect", () => {
  it("fills exactly when frame and backing match (all fit modes agree)", () => {
    for (const fit of ["fill", "contain", "cover"] as const) {
      expect(frameDestRect(state({ fit }))).toEqual({ dx: 0, dy: 0, dw: 1280, dh: 720 });
    }
  });

  it("contain: letterboxes a 16:9 frame into a 4:3 backing (bars top/bottom)", () => {
    // sx = 640/1280 = 0.5, sy = 480/720 = 0.667 -> contain scale = 0.5
    const r = frameDestRect(state({ backingW: 640, backingH: 480, fit: "contain" }));
    expect(r).toEqual({ dx: 0, dy: 60, dw: 640, dh: 360 });
  });

  it("cover: crops a 4:3 frame into a 16:9 backing (overflow left/right)", () => {
    // frame 800x600 into backing 1280x720: sx=1.6, sy=1.2 -> cover scale = 1.6
    const r = frameDestRect(state({ frameW: 800, frameH: 600, backingW: 1280, backingH: 720, fit: "cover" }));
    expect(r.dw).toBeCloseTo(1280);
    expect(r.dh).toBeCloseTo(960);
    expect(r.dx).toBeCloseTo(0);
    expect(r.dy).toBeCloseTo(-120); // overflows top/bottom, clipped by the canvas
  });

  it("fill: stretches each axis independently", () => {
    const { scaleX, scaleY } = fitScales(state({ frameW: 800, frameH: 600, backingW: 1280, backingH: 720, fit: "fill" }));
    expect(scaleX).toBeCloseTo(1.6);
    expect(scaleY).toBeCloseTo(1.2);
  });
});

describe("backingToFrame", () => {
  it("is the inverse of frameDestRect at the center and corners (contain)", () => {
    const v = state({ backingW: 640, backingH: 480, fit: "contain" });
    // center of the backing maps to the center of the frame
    const c = backingToFrame(v, 320, 240);
    expect(c.x).toBeCloseTo(640);
    expect(c.y).toBeCloseTo(360);
    expect(c.inside).toBe(true);
    // top-left of the drawn frame rect (dx=0, dy=60) maps to frame (0,0)
    const tl = backingToFrame(v, 0, 60);
    expect(tl.x).toBeCloseTo(0);
    expect(tl.y).toBeCloseTo(0);
  });

  it("flags points in the letterbox padding as outside the frame", () => {
    const v = state({ backingW: 640, backingH: 480, fit: "contain" });
    // y=10 is inside the 60px top letterbox bar
    const bar = backingToFrame(v, 320, 10);
    expect(bar.inside).toBe(false);
    expect(bar.y).toBeLessThan(0);
  });

  it("round-trips a frame point through the dest rect and back", () => {
    const v = state({ frameW: 1280, frameH: 720, backingW: 900, backingH: 900, fit: "contain" });
    const { dx, dy, dw, dh } = frameDestRect(v);
    // pick frame point (400, 300); its backing position, mapped back, returns it
    const bx = dx + (400 / v.frameW) * dw;
    const by = dy + (300 / v.frameH) * dh;
    const back = backingToFrame(v, bx, by);
    expect(back.x).toBeCloseTo(400);
    expect(back.y).toBeCloseTo(300);
    expect(back.inside).toBe(true);
  });

  it("displays a 2x frame at half pixel size and maps center->center (logical fit)", () => {
    // A 1280x720 frame with pixel_ratio 2 represents 640x360 logical px. Shown in a
    // 640x360 window (1x) it should fill at HALF its pixel size (dw=640, not 1280) --
    // frame render DPR cancels out of the geometry, so `contain` alone gets this right.
    const v = state({ frameW: 1280, frameH: 720, backingW: 640, backingH: 360, fit: "contain" });
    expect(frameDestRect(v)).toEqual({ dx: 0, dy: 0, dw: 640, dh: 360 });
    const c = backingToFrame(v, 320, 180);
    expect(c.x).toBeCloseTo(640);
    expect(c.y).toBeCloseTo(360);
    expect(c.inside).toBe(true);
  });

  it("maps a click at DPR=2 with a matching stream size back to CSS coords", () => {
    // stream 640x480, canvas backing 1280x960 (dpr 2). A CSS click at (100,50) becomes
    // backing (200,100); contain scale = 2 -> frame (100,50) == the CSS coordinate.
    const v = state({ frameW: 640, frameH: 480, backingW: 1280, backingH: 960, fit: "contain" });
    const r = backingToFrame(v, 200, 100);
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(50);
    expect(r.inside).toBe(true);
  });
});
