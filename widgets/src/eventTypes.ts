// DOM-free event type definitions, shared by the main thread and the worker.
// Kept separate from events.ts (which references DOM event types) so worker code
// — compiled with the WebWorker lib and no DOM — can import these safely.

export type Modifier = "shift" | "ctrl" | "alt" | "meta";

export interface NormalizedPointerEvent {
  type: "pointer_move" | "pointer_down" | "pointer_up";
  x: number;
  y: number;
  button?: number;
  buttons: number;
  modifiers: Modifier[];
}
export interface NormalizedWheelEvent {
  type: "wheel";
  x: number;
  y: number;
  dx: number;
  dy: number;
  mode: "pixel";
  modifiers: Modifier[];
}
export interface NormalizedKeyEvent {
  type: "key_down" | "key_up";
  key: string;
  code: string;
  modifiers: Modifier[];
}
export interface NormalizedResize {
  type: "resize";
  width: number;
  height: number;
  pixel_ratio: number;
}
export type NormalizedEvent =
  | NormalizedPointerEvent
  | NormalizedWheelEvent
  | NormalizedKeyEvent
  | NormalizedResize;

/** Backing-store vs CSS-box geometry. backingW/H == canvas.width/height. */
export interface BackingGeometry {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
}

export interface ModifierSource {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export const LINE_HEIGHT_PX = 16;
