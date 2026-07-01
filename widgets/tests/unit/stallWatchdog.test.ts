import { describe, expect, it, vi } from "vitest";
import { StallWatchdog } from "../../src/worker/stallWatchdog";

function make(stallMs = 1000) {
  let t = 0;
  const now = () => t;
  const onStall = vi.fn();
  const wd = new StallWatchdog(stallMs, now, onStall);
  return { wd, onStall, advance: (ms: number) => (t += ms), at: (ms: number) => (t = ms) };
}

describe("StallWatchdog", () => {
  it("trips when chunks are queued but never displayed", () => {
    const { wd, onStall, advance } = make(1000);
    wd.onQueued();
    wd.onQueued(); // 2 pending, 0 displayed (the reorder/HW-buffer case: never emits)
    expect(wd.check()).toBe(false); // no time has passed
    advance(1200);
    expect(wd.check()).toBe(true);
    expect(onStall).toHaveBeenCalledTimes(1);
    // Only trips once per stall edge.
    expect(wd.check()).toBe(false);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("does not trip while the decoder keeps emitting (slow but progressing)", () => {
    const { wd, advance } = make(1000);
    for (let i = 0; i < 5; i++) {
      wd.onQueued();
      advance(400); // 400ms/frame < 1000ms stall window
      wd.onDisplayed();
      expect(wd.check()).toBe(false);
    }
  });

  it("does not trip when fully caught up", () => {
    const { wd, advance } = make(1000);
    wd.onQueued();
    wd.onDisplayed(); // pending == 0
    advance(5000);
    expect(wd.check()).toBe(false);
  });

  it("measures from when a backlog begins, not from an earlier idle period", () => {
    const { wd, advance } = make(1000);
    wd.onQueued();
    wd.onDisplayed(); // caught up
    advance(10_000); // long idle — must not count against the next chunk
    wd.onQueued(); // backlog starts *now*
    expect(wd.check()).toBe(false);
    advance(1200);
    expect(wd.check()).toBe(true);
  });

  it("re-arms after reset()", () => {
    const { wd, onStall, advance } = make(1000);
    wd.onQueued();
    advance(1200);
    expect(wd.check()).toBe(true);
    wd.reset();
    expect(wd.pending).toBe(0);
    wd.onQueued();
    advance(1200);
    expect(wd.check()).toBe(true);
    expect(onStall).toHaveBeenCalledTimes(2);
  });
});
