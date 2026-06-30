// DOM event -> normalized event vocabulary (the renderview spec; see eventTypes.ts).
// The server is sent *logical* canvas coordinates (CSS pixels relative to the canvas,
// top-left origin); the publisher owns the render resolution and maps logical -> its
// own framebuffer using the `ratio` carried on resize events. Pure helpers here are
// unit-tested in node.

import {
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
  if (ev.shiftKey) mods.push("Shift");
  if (ev.ctrlKey) mods.push("Control");
  if (ev.altKey) mods.push("Alt");
  if (ev.metaKey) mods.push("Meta");
  return mods;
}

/** Map a DOM `MouseEvent.button` to the renderview button (0=none,1=left,2=right,3=middle). */
export function mapButton(domButton: number): number {
  switch (domButton) {
    case 0:
      return 1; // left
    case 1:
      return 3; // middle
    case 2:
      return 2; // right
    case 3:
      return 4; // back
    case 4:
      return 5; // forward
    default:
      return 0; // none (DOM uses -1 for pointermove with no button change)
  }
}

/** Map a DOM `MouseEvent.buttons` bitmask to a renderview tuple of pressed buttons. */
export function mapButtons(domButtons: number): number[] {
  const out: number[] = [];
  if (domButtons & 1) out.push(1); // left
  if (domButtons & 2) out.push(2); // right
  if (domButtons & 4) out.push(3); // middle
  if (domButtons & 8) out.push(4); // back
  if (domButtons & 16) out.push(5); // forward
  return out;
}

/** Map a CSS-space point to logical canvas coordinates (top-left origin). */
export function pointerToCanvas(cssX: number, cssY: number, rect: DOMRect): { x: number; y: number } {
  return { x: cssX - rect.left, y: cssY - rect.top };
}

/** Normalize a wheel delta to pixels (deltaMode 0=pixel, 1=line, 2=page). */
export function wheelDeltaToPixels(delta: number, deltaMode: number, pageSizePx: number): number {
  if (deltaMode === 1) return delta * LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * pageSizePx;
  return delta;
}

export function normalizePointerEvent(ev: PointerEvent, rect: DOMRect): NormalizedPointerEvent {
  const { x, y } = pointerToCanvas(ev.clientX, ev.clientY, rect);
  const type =
    ev.type === "pointerdown"
      ? "pointer_down"
      : ev.type === "pointerup"
        ? "pointer_up"
        : "pointer_move";
  return {
    type,
    x,
    y,
    button: mapButton(ev.button),
    buttons: mapButtons(ev.buttons),
    modifiers: extractModifiers(ev),
    timestamp: ev.timeStamp / 1000,
  };
}

export function normalizeWheelEvent(ev: WheelEvent, rect: DOMRect): NormalizedWheelEvent {
  const { x, y } = pointerToCanvas(ev.clientX, ev.clientY, rect);
  return {
    type: "wheel",
    x,
    y,
    dx: wheelDeltaToPixels(ev.deltaX, ev.deltaMode, rect.width),
    dy: wheelDeltaToPixels(ev.deltaY, ev.deltaMode, rect.height),
    buttons: mapButtons(ev.buttons),
    modifiers: extractModifiers(ev),
    timestamp: ev.timeStamp / 1000,
  };
}

export function normalizeKeyEvent(ev: KeyboardEvent): NormalizedKeyEvent {
  return {
    type: ev.type === "keydown" ? "key_down" : "key_up",
    key: ev.key,
    code: ev.code,
    modifiers: extractModifiers(ev),
    timestamp: ev.timeStamp / 1000,
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
