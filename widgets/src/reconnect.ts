// Auto-reconnect policy for the worker's WebSocket. Pure + side-effect-free so it can be
// unit-tested without the worker globals; the wiring lives in worker/entry.ts.

/** Backoff bounds, in milliseconds. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 10_000;

/**
 * Exponential backoff with full jitter, capped. `attempt` is 0-based (0 = first retry).
 *
 * Returns a delay in `[ceil/2, ceil]` where `ceil = min(MAX, BASE * 2**attempt)`. The jitter
 * spreads reconnect storms (many viewers of one server that just restarted) and the cap keeps
 * a long outage from stretching the retry interval unboundedly.
 */
export function reconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const ceil = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(ceil * (0.5 + 0.5 * rand()));
}

/**
 * Close codes that mean "do not retry" — the server rejected us on purpose, so reconnecting
 * would just loop. 4401 = auth rejected, 4404 = unknown stream (see the wire protocol).
 * Normal closes (1000/1001) only happen on our own teardown, which is guarded separately.
 */
export function isPermanentClose(code: number): boolean {
  return code === 4401 || code === 4404;
}
