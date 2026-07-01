// A decode *stall* detector, separate from the *backlog* detector (BackpressureController's
// decodeQueueSize heuristic). The failure it catches: chunks are queued but the decoder
// emits **nothing** — a hardware decoder buffering its DPB, a transient decode error on the
// frames in flight, a dropped keyframe. decodeQueueSize can stay low the whole time, so that
// heuristic never trips; this one keys off "queued but not displayed for a wall-clock window".
//
// Pure and DOM-free (no VideoDecoder), so it is unit-testable without a browser: feed it
// onQueued/onDisplayed + an injected clock and assert check() trips. See the resilience
// proposal (docs/proposals/completed/client_decode_resilience.md).

export class StallWatchdog {
  private queued = 0;
  private displayed = 0;
  /** Wall-clock when the current outstanding backlog began (`null` = nothing pending).
   *  A nullable — not a 0 sentinel — so a legitimate timestamp of 0 isn't read as "idle". */
  private oldestPendingAt: number | null = null;
  private stalled = false;

  /**
   * @param stallMs  how long a backlog may sit with zero new output before it's a stall.
   * @param now      monotonic clock in ms (inject `performance.now`; overridable for tests).
   * @param onStall  fired once per stall edge (check() also returns true on that edge).
   */
  constructor(
    private stallMs: number,
    private now: () => number,
    private onStall: () => void,
  ) {}

  /** A chunk was handed to the decoder. Starts the stall timer if we were caught up. */
  onQueued(): void {
    const wasIdle = this.queued === this.displayed;
    this.queued += 1;
    if (wasIdle) this.oldestPendingAt = this.now();
  }

  /** The decoder emitted a frame — progress. Clears the stall, restarts the timer if a
   *  backlog remains (so slow-but-progressing decode never trips). */
  onDisplayed(): void {
    this.displayed += 1;
    this.stalled = false;
    this.oldestPendingAt = this.queued === this.displayed ? null : this.now();
  }

  /** Forget the outstanding backlog (decoder rebuilt / stream reset). */
  reset(): void {
    this.queued = 0;
    this.displayed = 0;
    this.oldestPendingAt = null;
    this.stalled = false;
  }

  /** True exactly once when a backlog has produced no output for `stallMs`. */
  check(): boolean {
    if (this.oldestPendingAt !== null && !this.stalled && this.now() - this.oldestPendingAt > this.stallMs) {
      this.stalled = true;
      this.onStall();
      return true;
    }
    return false;
  }

  get pending(): number {
    return this.queued - this.displayed;
  }
}
