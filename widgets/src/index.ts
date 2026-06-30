// Public API surface. Worker internals (src/worker/*) are intentionally not
// exported.

export const version = "0.1.0-alpha";

export { RemoteFramebufferView } from "./RemoteFramebufferView";
export type { RfbViewOptions } from "./RemoteFramebufferView";

export { unpackBinaryMessage, packBinaryMessage } from "./protocol";
export type {
  BinaryHeader,
  ImageFrameHeader,
  VideoChunkHeader,
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

export type { ConnectionState, Stats } from "./types";
