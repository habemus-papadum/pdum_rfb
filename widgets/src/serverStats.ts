// Pure helpers that fold the server's `stats` / `set_quality` control messages
// into the client-facing `Stats` object. Kept side-effect-free so the worker can
// apply them in one place and they can be unit-tested without a WebSocket.

import type { SetQualityMsg, StatsMsg } from "./protocol";
import type { Stats } from "./types";

/** Merge a server-truth `stats` message into `stats` (returns a new object). */
export function applyServerStats(stats: Stats, msg: StatsMsg): Stats {
  const next = { ...stats };
  if (msg.rtt_ms !== undefined) next.serverRttMs = msg.rtt_ms;
  if (msg.fps_sent !== undefined) next.serverFpsSent = msg.fps_sent;
  if (msg.bitrate_bps !== undefined) next.serverBitrateBps = msg.bitrate_bps;
  if (msg.encode_ms !== undefined) next.serverEncodeMs = msg.encode_ms;
  if (msg.dropped !== undefined) next.serverDropped = msg.dropped;
  if (msg.target_bitrate !== undefined) next.targetBitrate = msg.target_bitrate;
  if (msg.target_fps !== undefined) next.targetFps = msg.target_fps;
  return next;
}

/** Merge an adaptive `set_quality` message (the new targets) into `stats`. */
export function applySetQuality(stats: Stats, msg: SetQualityMsg): Stats {
  const next = { ...stats };
  if (msg.bitrate !== undefined) next.targetBitrate = msg.bitrate;
  if (msg.fps !== undefined) next.targetFps = msg.fps;
  return next;
}
