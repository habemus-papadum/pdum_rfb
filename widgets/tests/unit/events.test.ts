import { describe, expect, it } from "vitest";

import {
  type BackingGeometry,
  computeBackingSize,
  extractModifiers,
  normalizeKeyEvent,
  normalizePointerEvent,
  normalizeWheelEvent,
  pointerToFramebuffer,
  wheelDeltaToPixels,
} from "../../src/events";

const geom = (dpr: number): BackingGeometry => ({
  cssWidth: 800,
  cssHeight: 450,
  backingWidth: 800 * dpr,
  backingHeight: 450 * dpr,
});

describe("pointerToFramebuffer", () => {
  it.each([1, 1.5, 2])("scales CSS coords by the backing ratio (dpr=%s)", (dpr) => {
    const { x, y } = pointerToFramebuffer(100, 50, geom(dpr));
    expect(x).toBe(Math.round(100 * dpr));
    expect(y).toBe(Math.round(50 * dpr));
  });

  it("clamps to the backing bounds", () => {
    const { x, y } = pointerToFramebuffer(10_000, -5, geom(2));
    expect(x).toBe(1599); // backingWidth(1600) - 1
    expect(y).toBe(0);
  });
});

describe("wheelDeltaToPixels", () => {
  it("passes pixel mode through", () => {
    expect(wheelDeltaToPixels(120, 0, 450)).toBe(120);
  });
  it("scales line mode by line height", () => {
    expect(wheelDeltaToPixels(3, 1, 450)).toBe(48);
  });
  it("scales page mode by page size", () => {
    expect(wheelDeltaToPixels(2, 2, 450)).toBe(900);
  });
});

describe("extractModifiers", () => {
  it("collects active modifiers", () => {
    expect(extractModifiers({ shiftKey: true, ctrlKey: false, altKey: true, metaKey: false })).toEqual([
      "shift",
      "alt",
    ]);
  });
});

describe("normalizers", () => {
  const rect = { left: 10, top: 20, width: 800, height: 450 } as DOMRect;

  it("normalizes a pointer event to framebuffer coords", () => {
    const ev = {
      type: "pointermove",
      clientX: 110,
      clientY: 70,
      button: 0,
      buttons: 1,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    } as PointerEvent;
    const out = normalizePointerEvent(ev, rect, geom(2));
    expect(out.type).toBe("pointer_move");
    expect(out.x).toBe(200); // (110-10)*2
    expect(out.y).toBe(100); // (70-20)*2
    expect(out.buttons).toBe(1);
  });

  it("normalizes a wheel event", () => {
    const ev = {
      clientX: 10,
      clientY: 20,
      deltaX: 0,
      deltaY: -120,
      deltaMode: 0,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    } as WheelEvent;
    const out = normalizeWheelEvent(ev, rect, geom(1));
    expect(out.mode).toBe("pixel");
    expect(out.dy).toBe(-120);
  });

  it("normalizes a key event", () => {
    const ev = {
      type: "keydown",
      key: "a",
      code: "KeyA",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    } as KeyboardEvent;
    const out = normalizeKeyEvent(ev);
    expect(out).toEqual({ type: "key_down", key: "a", code: "KeyA", modifiers: ["shift"] });
  });
});

describe("computeBackingSize", () => {
  it("multiplies by dpr", () => {
    expect(computeBackingSize(800, 450, 2)).toEqual({
      backingWidth: 1600,
      backingHeight: 900,
      pixelRatio: 2,
    });
  });

  it("caps at maxDim and reports the effective ratio", () => {
    const r = computeBackingSize(2000, 1000, 2, 2000);
    expect(Math.max(r.backingWidth, r.backingHeight)).toBeLessThanOrEqual(2000);
    expect(r.pixelRatio).toBeCloseTo(r.backingWidth / 2000, 5);
  });
});
