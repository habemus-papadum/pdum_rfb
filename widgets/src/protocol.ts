// Binary envelope + control message types. Must stay byte-for-byte compatible
// with the Python `pdum.rfb.protocol.pack_binary_message`:
//
//   uint32le header_byte_length | utf8 JSON header | raw payload bytes

import type { NormalizedEvent } from "./eventTypes";

/** A stream color descriptor (mirrors WebCodecs `VideoColorSpace` + range/depth). */
export interface ColorDescriptor {
  primaries?: "bt709" | "display-p3" | "bt2020";
  transfer?: "srgb" | "bt709" | "pq" | "hlg" | "linear";
  matrix?: "rgb" | "bt709" | "bt2020-ncl";
  full_range?: boolean;
  bit_depth?: number;
}

export interface ImageFrameHeader {
  type: "image_frame";
  seq: number;
  timestamp_us?: number;
  width: number;
  height: number;
  mime: string;
  /** Render-side DPR of this frame (device px per logical px); absent ⇒ 1. */
  pixel_ratio?: number;
  /** Color descriptor; absent ⇒ sRGB. */
  color?: ColorDescriptor;
}

export interface VideoChunkHeader {
  type: "video_chunk";
  seq: number;
  timestamp_us: number;
  duration_us?: number;
  width: number;
  height: number;
  codec: string;
  bitstream: "annexb" | "avcc";
  keyframe: boolean;
  /** Render-side DPR of this frame (device px per logical px); absent ⇒ 1. */
  pixel_ratio?: number;
  /** Color descriptor; absent ⇒ sRGB. */
  color?: ColorDescriptor;
}

export type BinaryHeader = ImageFrameHeader | VideoChunkHeader;

export interface UnpackedMessage {
  header: BinaryHeader & Record<string, unknown>;
  payload: Uint8Array;
}

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

/** Decode a binary message. Robust to a Uint8Array view with a nonzero offset. */
export function unpackBinaryMessage(input: ArrayBuffer | Uint8Array): UnpackedMessage {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.byteLength < 4) {
    throw new Error("buffer too small to contain a header length prefix");
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = view.getUint32(0, true);
  if (u8.byteLength < 4 + n) {
    throw new Error(`buffer truncated: need ${4 + n} bytes, have ${u8.byteLength}`);
  }
  const header = JSON.parse(textDecoder.decode(u8.subarray(4, 4 + n)));
  const payload = u8.subarray(4 + n);
  return { header, payload };
}

/** Pack a header + payload (used by the demo/tests; the client mostly receives). */
export function packBinaryMessage(header: object, payload: Uint8Array): ArrayBuffer {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.length + payload.length);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  out.set(payload, 4 + headerBytes.length);
  return out.buffer;
}

// --- Control messages (client -> server) ---
export interface HelloMsg {
  type: "hello";
  supported: string[];
  device_pixel_ratio: number;
  /** Optional auth credential (e.g. a Google OAuth ID token) the server verifies. */
  token?: string;
}
export interface AckMsg {
  type: "ack";
  seq: number;
  decode_queue_size: number;
  displayed?: boolean;
}
export interface RequestKeyframeMsg {
  type: "request_keyframe";
  reason: string;
}
export interface SetViewportMsg {
  type: "set_viewport";
  /** Logical (CSS) size. */
  width: number;
  height: number;
  /** Physical (backing-store) size. */
  pwidth: number;
  pheight: number;
  ratio: number;
}
export interface EventMsg {
  type: "event";
  event: NormalizedEvent;
}
export type ClientControl = HelloMsg | AckMsg | RequestKeyframeMsg | SetViewportMsg | EventMsg;

// --- Control messages (server -> client) ---
export interface ConfigMsg {
  type: "config";
  transport: "image" | "webcodecs";
  codec?: string;
  width: number;
  height: number;
  /** Event coordinate space the client sends; always `"frame-pixels"` in this version. */
  coords?: "frame-pixels";
  /** Initial render-side DPR hint (per-frame headers keep it current); absent ⇒ 1. */
  pixel_ratio?: number;
  /** Stream color descriptor; absent ⇒ sRGB. */
  color?: ColorDescriptor;
}
export interface SetQualityMsg {
  type: "set_quality";
  bitrate?: number;
  fps?: number;
}
export interface StatsMsg {
  type: "stats";
  // Authoritative server-side metrics (see SessionMetrics.snapshot); all optional
  // so the client tolerates partial/extended payloads.
  rtt_ms?: number;
  fps_sent?: number;
  fps_acked?: number;
  bitrate_bps?: number;
  encode_ms?: number;
  decode_queue_size?: number;
  dropped?: number;
  target_bitrate?: number;
  target_fps?: number;
}
export type ServerControl = ConfigMsg | SetQualityMsg | StatsMsg;
