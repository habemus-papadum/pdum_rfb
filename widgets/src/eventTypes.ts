// DOM-free event type definitions, shared by the main thread and the worker.
// Kept separate from events.ts (which references DOM event types) so worker code
// — compiled with the WebWorker lib and no DOM — can import these safely.
//
// The vocabulary follows the renderview spec (https://github.com/pygfx/renderview),
// the event schema shared by jupyter_rfb / pygfx / fastplotlib / rendercanvas, so
// events feed those consumers (and a future rendercanvas backend) without a remap:
//   - `type` names the event;
//   - coordinates are logical (canvas-relative CSS) pixels, top-left origin;
//   - `button` is 0=none, 1=left, 2=right, 3=middle, 4-9=…; `buttons` is the tuple
//     of currently-pressed buttons (same numbering);
//   - `modifiers` are capitalized: "Shift", "Control", "Alt", "Meta";
//   - `timestamp` is in seconds.

export type Modifier = "Shift" | "Control" | "Alt" | "Meta";

export interface NormalizedPointerEvent {
  type: "pointer_move" | "pointer_down" | "pointer_up";
  x: number;
  y: number;
  /** Renderview button: 0=none, 1=left, 2=right, 3=middle, 4-9=…. */
  button: number;
  /** Currently-pressed buttons (renderview numbering). */
  buttons: number[];
  modifiers: Modifier[];
  timestamp: number;
}
export interface NormalizedWheelEvent {
  type: "wheel";
  x: number;
  y: number;
  dx: number;
  dy: number;
  buttons: number[];
  modifiers: Modifier[];
  timestamp: number;
}
export interface NormalizedKeyEvent {
  type: "key_down" | "key_up";
  key: string;
  /** Physical-key identity (DOM `KeyboardEvent.code`); an additive extra over renderview. */
  code: string;
  modifiers: Modifier[];
  timestamp: number;
}
export interface NormalizedResize {
  type: "resize";
  /** Logical (CSS) size. */
  width: number;
  height: number;
  /** Physical (backing-store) size. */
  pwidth: number;
  pheight: number;
  ratio: number;
}
export type NormalizedEvent =
  | NormalizedPointerEvent
  | NormalizedWheelEvent
  | NormalizedKeyEvent
  | NormalizedResize;

export interface ModifierSource {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export const LINE_HEIGHT_PX = 16;
