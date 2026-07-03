// Backend conformance harness (main-thread, server-free). Builds a DisplaySurface for the
// requested backend, uploads ONE controlled asymmetric frame, presents it with real
// viewport geometry, reads the pixels back, and publishes them on window.__surface. The e2e
// asserts orientation (the four quadrant colors are distinct and flip-sensitive), scaling,
// letterbox background, and that WebGL is pixel-equal to the Canvas2D floor at 1:1.

import type { SurfacePreference } from "../src/types";
import { presentGeometry, type FitMode } from "../src/viewport";
import { createDisplaySurface } from "../src/worker/surfaceFactory";

const params = new URLSearchParams(location.search);
const requested = (params.get("surface") as SurfacePreference | null) ?? "2d";
const [frameW, frameH] = (params.get("frame") ?? "64x64").split("x").map(Number);
const [backingW, backingH] = (params.get("backing") ?? `${frameW}x${frameH}`).split("x").map(Number);
const fit = (params.get("fit") as FitMode | null) ?? "fill";
const background = params.get("bg") ?? "#123456";
// Optional viewport transform (roadmap item 1): zoom about the canvas center + backing-px pan.
const zoom = params.get("zoom") ? Number(params.get("zoom")) : 1;
const panX = params.get("panx") ? Number(params.get("panx")) : 0;
const panY = params.get("pany") ? Number(params.get("pany")) : 0;

// A deliberately asymmetric source: TL red, TR green, BL blue, BR white. White lives in
// exactly one corner, so ANY horizontal/vertical flip or transpose is detectable.
const src = new OffscreenCanvas(frameW, frameH);
const sctx = src.getContext("2d")!;
const hw = Math.floor(frameW / 2);
const hh = Math.floor(frameH / 2);
sctx.fillStyle = "rgb(255,0,0)";
sctx.fillRect(0, 0, hw, hh);
sctx.fillStyle = "rgb(0,255,0)";
sctx.fillRect(hw, 0, frameW - hw, hh);
sctx.fillStyle = "rgb(0,0,255)";
sctx.fillRect(0, hh, hw, frameH - hh);
sctx.fillStyle = "rgb(255,255,255)";
sctx.fillRect(hw, hh, frameW - hw, frameH - hh);

// Which frame TYPE to feed the surface — the real paths differ, and orientation conventions
// differ by type, so the conformance spec exercises each: "bitmap" = ImageBitmap (image
// path), "videoframe" = VideoFrame (video path), "canvas" = raw OffscreenCanvas.
const sourceKind = params.get("source") ?? "bitmap";

async function makeFrame(): Promise<CanvasImageSource> {
  if (sourceKind === "canvas") return src;
  if (sourceKind === "videoframe") return new VideoFrame(src, { timestamp: 0 });
  return createImageBitmap(src);
}

async function run(): Promise<void> {
  const canvas = new OffscreenCanvas(backingW, backingH);
  const surface = await createDisplaySurface(canvas, requested);
  const frame = await makeFrame();
  surface.setFrame(frame, frameW, frameH);
  (frame as { close?: () => void }).close?.();
  const geom = presentGeometry({ frameW, frameH, backingW, backingH, fit, zoom, panX, panY });
  surface.present(geom, background);
  const img = await surface.readPixels();

  (globalThis as unknown as { __surface: unknown }).__surface = {
    kind: surface.kind,
    requested,
    width: img.width,
    height: img.height,
    data: Array.from(img.data),
    geom,
  };
}

void run();
