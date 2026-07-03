// Tiny, dependency-free client logger with three tiers:
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
// Works identically on the main thread and inside the Web Worker (both have `console`).

export interface Logger {
  /** Whether the verbose `log()` stream is enabled. */
  readonly enabled: boolean;
  /** Verbose diagnostic line — emitted only when `debug` is on (console.debug). */
  log(category: string, ...args: unknown[]): void;
  /** A notable, rare lifecycle event — emitted unless notices are disabled (console.info). */
  notice(category: string, ...args: unknown[]): void;
  /** A genuine error — always emitted (console.error), regardless of the other tiers. */
  error(category: string, ...args: unknown[]): void;
}

const noop = () => {};

/**
 * Build a logger.
 *
 * @param debug   Enable the verbose per-frame `log()` stream (default off).
 * @param tag     Short prefix (`[rfb:<tag>]`) identifying the emitter.
 * @param notice  Enable the `notice()` lifecycle stream (default ON).
 */
export function makeLogger(debug: boolean, tag: string, notice = true): Logger {
  const prefix = `[rfb:${tag}]`;
  return {
    enabled: debug,
    log: debug ? (category, ...args) => console.debug(`${prefix} ${category}`, ...args) : noop,
    notice: notice ? (category, ...args) => console.info(`${prefix} ${category}`, ...args) : noop,
    error: (category, ...args) => console.error(`${prefix} ${category}`, ...args),
  };
}
