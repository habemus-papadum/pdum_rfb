import { describe, expect, it } from "vitest";

import { applyServerStats, applySetQuality } from "../../src/serverStats";
import type { Stats } from "../../src/types";

const base: Stats = {
  framesDisplayed: 3,
  framesDropped: 0,
  lastDisplayedSeq: 2,
  decodeQueueSize: 1,
  transport: "webcodecs",
};

describe("applyServerStats", () => {
  it("folds server-truth metrics into Stats without touching decode-side fields", () => {
    const next = applyServerStats(base, {
      type: "stats",
      rtt_ms: 42,
      fps_sent: 29.5,
      bitrate_bps: 8_000_000,
      encode_ms: 2.1,
      dropped: 4,
      target_bitrate: 6_000_000,
      target_fps: 20,
    });
    expect(next.serverRttMs).toBe(42);
    expect(next.serverFpsSent).toBe(29.5);
    expect(next.serverBitrateBps).toBe(8_000_000);
    expect(next.serverEncodeMs).toBe(2.1);
    expect(next.serverDropped).toBe(4);
    expect(next.targetBitrate).toBe(6_000_000);
    expect(next.targetFps).toBe(20);
    // Local decode-side fields are preserved; the input is not mutated.
    expect(next.framesDisplayed).toBe(3);
    expect(next.transport).toBe("webcodecs");
    expect(base.serverRttMs).toBeUndefined();
  });

  it("only overwrites fields that are present", () => {
    const seeded = { ...base, serverRttMs: 10, targetFps: 30 };
    const next = applyServerStats(seeded, { type: "stats", rtt_ms: 55 });
    expect(next.serverRttMs).toBe(55);
    expect(next.targetFps).toBe(30); // absent in the message -> unchanged
  });
});

describe("applySetQuality", () => {
  it("records the adaptive targets", () => {
    const next = applySetQuality(base, { type: "set_quality", bitrate: 5_000_000, fps: 15 });
    expect(next.targetBitrate).toBe(5_000_000);
    expect(next.targetFps).toBe(15);
  });
});
