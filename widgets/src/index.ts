// Public API surface. Worker internals (src/worker/*) are intentionally not
// exported.

export { RemoteFramebufferView } from "./RemoteFramebufferView";
export type { RfbViewOptions } from "./RemoteFramebufferView";

// Managed present on the MAIN THREAD (feed-mode worker + main-thread drawImage). Same surface
// as RemoteFramebufferView, but no OffscreenCanvas transfer — resilient to embedding hosts that
// reparent the widget subtree (marimo). See docs/proposals/active/marimo_rendering_fix.md.
export { MainThreadPresentView } from "./MainThreadPresentView";
export type { MainThreadPresentOptions } from "./MainThreadPresentView";

// Mode B (frame-as-texture): stream into the caller's own WebGL2/WebGPU context.
export { FrameTextureFeed } from "./FrameTextureFeed";
export type { FrameTextureFeedOptions } from "./FrameTextureFeed";
export { WebglFrameTexture } from "./webglFrameTexture";
export { WebgpuFrameTexture } from "./webgpuFrameTexture";

// Client-side recording of what the viewer sees (canvas.captureStream -> MediaRecorder). Only
// usable on a view that owns a main-thread canvas (MainThreadPresentView); Mode A throws.
export {
  startCanvasRecording,
  recordingSupported,
  pickRecordingMimeType,
  RECORDING_UNSUPPORTED_MESSAGE,
} from "./recording";
export type { RecordingOptions, CanvasRecordingSession } from "./recording";

export { unpackBinaryMessage, packBinaryMessage } from "./protocol";
export type {
  BinaryHeader,
  ImageFrameHeader,
  VideoChunkHeader,
  ColorDescriptor,
  UnpackedMessage,
  ClientControl,
  ServerControl,
  ConfigMsg,
  HelloMsg,
  AckMsg,
} from "./protocol";

export {
  probeCapabilities,
  isCodecSupported,
  CAP_JPEG,
  CAP_PNG,
  CAP_H264_ANNEXB,
  DEFAULT_H264_CODEC,
} from "./capabilities";
export type { Capabilities } from "./capabilities";

export { BackpressureController, KeyframeGate } from "./backpressure";

export {
  frameDestRect,
  backingToFrame,
  fitScales,
  effectiveScales,
  presentGeometry,
  clampZoom,
  transformOf,
  zoomAround,
  panByBacking,
  centerOnFrame,
  presetFraming,
  IDENTITY_TRANSFORM,
  DEFAULT_MIN_ZOOM,
  DEFAULT_MAX_ZOOM,
} from "./viewport";
export type {
  FitMode,
  ViewportState,
  DestRect,
  Rect,
  PresentGeometry,
  ViewportTransform,
  ViewportFraming,
  ViewPreset,
} from "./viewport";

export {
  normalizePointerEvent,
  normalizeWheelEvent,
  normalizeKeyEvent,
  pointerToCanvas,
  mapButton,
  mapButtons,
  computeBackingSize,
} from "./events";
export type {
  NormalizedEvent,
  NormalizedPointerEvent,
  NormalizedWheelEvent,
  NormalizedKeyEvent,
  NormalizedResize,
  Modifier,
} from "./eventTypes";

export type { ConnectionState, Stats, SurfaceKind, SurfacePreference } from "./types";

export { computeStatus } from "./statusOverlay";
export type { StatusKind, StatusRenderer, ViewStatus } from "./statusOverlay";
