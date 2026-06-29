import { describe, expect, it } from "vitest";

import { BackpressureController, KeyframeGate } from "../../src/backpressure";

describe("BackpressureController", () => {
  it("tracks inflight via queued/displayed FIFO", () => {
    const bp = new BackpressureController({ maxInflight: 3 });
    bp.onQueued(0);
    bp.onQueued(1);
    expect(bp.inflight).toBe(2);
    expect(bp.onDisplayed()).toBe(0); // FIFO order
    expect(bp.onDisplayed()).toBe(1);
    expect(bp.inflight).toBe(0);
    expect(bp.onDisplayed()).toBeUndefined();
  });

  it("computes slow-down and keyframe thresholds", () => {
    const bp = new BackpressureController({ slowDownQueue: 3, keyframeOnDropQueue: 6 });
    expect(bp.shouldSlowDown(3)).toBe(false);
    expect(bp.shouldSlowDown(4)).toBe(true);
    expect(bp.shouldRequestKeyframe(6)).toBe(false);
    expect(bp.shouldRequestKeyframe(7)).toBe(true);
  });

  it("builds an ack message", () => {
    const bp = new BackpressureController();
    expect(bp.buildAck(5, 2, true)).toEqual({
      type: "ack",
      seq: 5,
      decode_queue_size: 2,
      displayed: true,
    });
  });

  it("reset clears the queue", () => {
    const bp = new BackpressureController();
    bp.onQueued(1);
    bp.reset();
    expect(bp.inflight).toBe(0);
  });
});

describe("KeyframeGate", () => {
  it("drops deltas until the first keyframe", () => {
    const gate = new KeyframeGate();
    expect(gate.needsKeyframe()).toBe(true);
    expect(gate.accept(false)).toBe(false); // delta dropped
    expect(gate.accept(true)).toBe(true); // keyframe accepted
    expect(gate.accept(false)).toBe(true); // subsequent deltas pass
    expect(gate.needsKeyframe()).toBe(false);
  });

  it("re-arms on reset", () => {
    const gate = new KeyframeGate();
    gate.accept(true);
    gate.reset();
    expect(gate.accept(false)).toBe(false);
  });
});
