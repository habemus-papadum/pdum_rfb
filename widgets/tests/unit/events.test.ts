import { describe, expect, it } from "vitest";

import {
  computeBackingSize,
  extractModifiers,
  mapButton,
  mapButtons,
  normalizeKeyEvent,
  normalizePointerEvent,
  normalizeWheelEvent,
  pointerToCanvas,
  wheelDeltaToPixels,
} from "../../src/events";

const rect = { left: 10, top: 20, width: 800, height: 450 } as DOMRect;

describe("pointerToCanvas", () => {
  it("returns canvas-relative logical coords (no backing scale)", () => {
    expect(pointerToCanvas(110, 70, rect)).toEqual({ x: 100, y: 50 });
  });
});

describe("mapButton", () => {
  it.each([
    [-1, 0], // pointermove: no button -> none
    [0, 1], // left
    [1, 3], // middle
    [2, 2], // right
    [3, 4], // back
    [4, 5], // forward
  ])("maps DOM button %s -> renderview %s", (dom, rv) => {
    expect(mapButton(dom)).toBe(rv);
  });
});

describe("mapButtons", () => {
  it("expands a DOM bitmask into a renderview tuple", () => {
    expect(mapButtons(0)).toEqual([]);
    expect(mapButtons(1)).toEqual([1]); // left
    expect(mapButtons(2)).toEqual([2]); // right
    expect(mapButtons(4)).toEqual([3]); // middle
    expect(mapButtons(1 | 2 | 4)).toEqual([1, 2, 3]);
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
  it("collects active modifiers, capitalized (renderview names)", () => {
    expect(
      extractModifiers({ shiftKey: true, ctrlKey: true, altKey: true, metaKey: false }),
    ).toEqual(["Shift", "Control", "Alt"]);
  });
});

describe("normalizers", () => {
  it("normalizes a pointer_down to logical coords + renderview button/buttons", () => {
    const ev = {
      type: "pointerdown",
      clientX: 110,
      clientY: 70,
      button: 0, // DOM left
      buttons: 1, // DOM left bitmask
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timeStamp: 1000,
    } as PointerEvent;
    expect(normalizePointerEvent(ev, rect)).toEqual({
      type: "pointer_down",
      x: 100,
      y: 50,
      button: 1,
      buttons: [1],
      modifiers: [],
      timestamp: 1,
    });
  });

  it("normalizes a wheel event (pixels, no mode field)", () => {
    const ev = {
      clientX: 10,
      clientY: 20,
      deltaX: 0,
      deltaY: -120,
      deltaMode: 0,
      buttons: 0,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timeStamp: 3000,
    } as WheelEvent;
    expect(normalizeWheelEvent(ev, rect)).toEqual({
      type: "wheel",
      x: 0,
      y: 0,
      dx: 0,
      dy: -120,
      buttons: [],
      modifiers: [],
      timestamp: 3,
    });
  });

  it("normalizes a key event (key + code, capitalized modifiers)", () => {
    const ev = {
      type: "keydown",
      key: "a",
      code: "KeyA",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timeStamp: 2000,
    } as KeyboardEvent;
    expect(normalizeKeyEvent(ev)).toEqual({
      type: "key_down",
      key: "a",
      code: "KeyA",
      modifiers: ["Shift"],
      timestamp: 2,
    });
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
