// The pluggable client draw path (Mode A: managed present). Canvas2D is the only
// backend today (canvas2dSurface.ts); WebGL2 / WebGPU slot in behind this same
// interface — see docs/proposals/completed/client_display_backend.md.
//
// The surface is PRESENTATION-FREE: it retains the current decoded frame in a
// BACKEND-NATIVE buffer and paints a `{ src, dst }` region of it. It knows nothing
// about fit / zoom / pan — that geometry is computed in viewport.ts and handed in via
// present(). Both drawing (present) and event-mapping (backingToFrame) go through that
// same geometry, so a click stays accurate under any fit.

import type { PresentGeometry } from "../viewport";
import type { SurfaceKind } from "../types";

export type { SurfaceKind };

export interface DisplaySurface {
  readonly kind: SurfaceKind;

  /** Choose the canvas color space (`"srgb"` | `"display-p3"`). Must precede the first
   *  draw/readPixels (context creation); ignored once the context exists. */
  setColorSpace(space: PredefinedColorSpace): void;

  /** Resize the backing store (device px). Clears it; the caller re-presents. */
  resize(backingW: number, backingH: number): void;

  /** Adopt a new decoded frame as the retained current frame. Copies what it needs
   *  synchronously (the caller closes `src` right after), so present() can repaint the
   *  frame later without it. `frameW/H` are the frame's DISPLAY size. */
  setFrame(src: CanvasImageSource, frameW: number, frameH: number): void;

  /** Paint the retained frame with an explicit geometry over `background`. Cheap and
   *  idempotent — safe to call every animation frame. With no frame retained yet it
   *  just clears to `background`. */
  present(geom: PresentGeometry, background: string): void;

  /** Read back the backing store (batteries capture() / e2e pixel readback). Async because
   *  GPU→CPU readback is inherently asynchronous (WebGPU); the 2D/WebGL backends resolve
   *  immediately. */
  readPixels(): Promise<ImageData>;
  toBlob(type?: string): Promise<Blob>;

  /** Release backend-native resources (retained frame, GPU handles). */
  dispose(): void;
}
