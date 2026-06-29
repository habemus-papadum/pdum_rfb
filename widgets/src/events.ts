// DOM event -> normalized event vocabulary. The server is sent framebuffer-pixel
// coordinates (CSS coords scaled by the effective backing ratio), so it maps 1:1
// to its render buffer. Pure helpers here are unit-tested in node.

import {
  type BackingGeometry,
  LINE_HEIGHT_PX,
  type Modifier,
  type ModifierSource,
  type NormalizedKeyEvent,
  type NormalizedPointerEvent,
  type NormalizedWheelEvent,
} from "./eventTypes";

export * from "./eventTypes";

export function extractModifiers(ev: ModifierSource): Modifier[] {
  const mods: Modifier[] = [];
  if (ev.shiftKey) mods.push("shift");
  if (ev.ctrlKey) mods.push("ctrl");
  if (ev.altKey) mods.push("alt");
  if (ev.metaKey) mods.push("meta");
  return mods;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Map a CSS-space point to integer framebuffer pixel coordinates. */
export function pointerToFramebuffer(
  cssX: number,
  cssY: number,
  geom: BackingGeometry,
): { x: number; y: number } {
  const sx = geom.cssWidth > 0 ? geom.backingWidth / geom.cssWidth : 1;
  const sy = geom.cssHeight > 0 ? geom.backingHeight / geom.cssHeight : 1;
  return {
    x: clamp(Math.round(cssX * sx), 0, Math.max(0, geom.backingWidth - 1)),
    y: clamp(Math.round(cssY * sy), 0, Math.max(0, geom.backingHeight - 1)),
  };
}

/** Normalize a wheel delta to pixels (deltaMode 0=pixel, 1=line, 2=page). */
export function wheelDeltaToPixels(delta: number, deltaMode: number, pageSizePx: number): number {
  if (deltaMode === 1) return delta * LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * pageSizePx;
  return delta;
}

export function normalizePointerEvent(
  ev: PointerEvent,
  rect: DOMRect,
  geom: BackingGeometry,
): NormalizedPointerEvent {
  const { x, y } = pointerToFramebuffer(ev.clientX - rect.left, ev.clientY - rect.top, geom);
  const type =
    ev.type === "pointerdown"
      ? "pointer_down"
      : ev.type === "pointerup"
        ? "pointer_up"
        : "pointer_move";
  return { type, x, y, button: ev.button, buttons: ev.buttons, modifiers: extractModifiers(ev) };
}

export function normalizeWheelEvent(
  ev: WheelEvent,
  rect: DOMRect,
  geom: BackingGeometry,
): NormalizedWheelEvent {
  const { x, y } = pointerToFramebuffer(ev.clientX - rect.left, ev.clientY - rect.top, geom);
  return {
    type: "wheel",
    x,
    y,
    dx: wheelDeltaToPixels(ev.deltaX, ev.deltaMode, geom.cssWidth),
    dy: wheelDeltaToPixels(ev.deltaY, ev.deltaMode, geom.cssHeight),
    mode: "pixel",
    modifiers: extractModifiers(ev),
  };
}

export function normalizeKeyEvent(ev: KeyboardEvent): NormalizedKeyEvent {
  return {
    type: ev.type === "keydown" ? "key_down" : "key_up",
    key: ev.key,
    code: ev.code,
    modifiers: extractModifiers(ev),
  };
}

/** Compute backing-store size from CSS size + DPR, capped to maxDim. */
export function computeBackingSize(
  cssW: number,
  cssH: number,
  dpr: number,
  maxDim?: number,
): { backingWidth: number; backingHeight: number; pixelRatio: number } {
  let bw = Math.max(1, Math.round(cssW * dpr));
  let bh = Math.max(1, Math.round(cssH * dpr));
  let pixelRatio = dpr;
  if (maxDim && Math.max(bw, bh) > maxDim) {
    const scale = maxDim / Math.max(bw, bh);
    bw = Math.max(1, Math.round(bw * scale));
    bh = Math.max(1, Math.round(bh * scale));
    pixelRatio = cssW > 0 ? bw / cssW : dpr;
  }
  return { backingWidth: bw, backingHeight: bh, pixelRatio };
}
