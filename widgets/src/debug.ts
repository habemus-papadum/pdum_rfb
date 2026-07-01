// Tiny, dependency-free client logger. The `debug` option (RfbViewOptions -> worker init)
// turns on a verbose play-by-play in the browser console: WebSocket lifecycle, capability
// negotiation, keyframe requests (with reasons), backpressure drops, and per-frame decode.
//
// Genuine failures (WebSocket error, decoder error, image-decode throw) are routed through
// `error()`, which ALWAYS logs — these are rare and actionable, and silently swallowing
// them (as the worker used to) is a debugging footgun. The `debug` toggle only gates the
// verbose `log()` stream on top of that. Works identically on the main thread and inside
// the Web Worker (both have `console`).

export interface Logger {
  /** Whether the verbose `log()` stream is enabled. */
  readonly enabled: boolean;
  /** Verbose diagnostic line — emitted only when `debug` is on (console.debug). */
  log(category: string, ...args: unknown[]): void;
  /** A genuine error — always emitted (console.error), debug on or off. */
  error(category: string, ...args: unknown[]): void;
}

const noop = () => {};

export function makeLogger(enabled: boolean, tag: string): Logger {
  const prefix = `[rfb:${tag}]`;
  return {
    enabled,
    log: enabled ? (category, ...args) => console.debug(`${prefix} ${category}`, ...args) : noop,
    error: (category, ...args) => console.error(`${prefix} ${category}`, ...args),
  };
}
