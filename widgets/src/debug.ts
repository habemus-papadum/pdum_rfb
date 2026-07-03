// Tiny client logger with three tiers:
//
//   error()  — a genuine failure (WS error, decoder error, image-decode throw). ALWAYS emitted
//              (console.error). Silently swallowing these (as the worker used to) is a footgun.
//   notice() — a rare, actionable lifecycle event: WS open/close/reconnect, negotiation, keyframe
//              requests, decode-queue backpressure, decoder reset/recovery, resize. ON by default
//              (console.info) so "normal events" are visible without the debug firehose; gate it
//              off with `notice: false` when you want silence.
//   log()    — the verbose per-frame play-by-play (decode of every frame, hello payloads, config
//              dumps). OFF by default; enable with the `debug` option.
//
// Works identically on the main thread and inside the Web Worker (both have `console`). The
// implementation is the generic `@habemus-papadum/worker-observability` logger; this module is
// the thin rfb-flavoured adapter that fixes the `[rfb:<tag>]` prefix convention. The
// worker→main log forwarding + the `window.__rfb` registry are layered on this same logger by
// the views (`registerObservable`) and the worker (`installWorkerObservability`).

import { buildLogger, type Logger } from "@habemus-papadum/worker-observability";

export type { Logger };

/**
 * Build a logger.
 *
 * @param debug   Enable the verbose per-frame `log()` stream (default off).
 * @param tag     Short prefix (`[rfb:<tag>]`) identifying the emitter.
 * @param notice  Enable the `notice()` lifecycle stream (default ON).
 */
export function makeLogger(debug: boolean, tag: string, notice = true): Logger {
  return buildLogger({ tag: `rfb:${tag}`, debug, notice });
}
