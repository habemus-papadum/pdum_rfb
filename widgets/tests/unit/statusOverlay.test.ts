import { describe, expect, it } from "vitest";
import { computeStatus } from "../../src/statusOverlay";

describe("computeStatus", () => {
  it("shows connecting until the first frame, even once the socket is open", () => {
    expect(computeStatus("connecting", 0).kind).toBe("connecting");
    // Socket open (or negotiated) but no frame yet is still 'connecting' — cover the blank.
    expect(computeStatus("open", 0).kind).toBe("connecting");
    expect(computeStatus("negotiated", 0).kind).toBe("connecting");
  });

  it("is live once frames flow", () => {
    const s = computeStatus("open", 5);
    expect(s.kind).toBe("live");
    expect(s.busy).toBe(false);
    expect(s.label).toBe("");
  });

  it("reflects connection problems even after frames have flowed", () => {
    expect(computeStatus("reconnecting", 5).kind).toBe("reconnecting");
    expect(computeStatus("closed", 5).kind).toBe("disconnected");
    expect(computeStatus("error", 5).kind).toBe("disconnected");
  });

  it("marks busy states (spinner) but not disconnected/live", () => {
    expect(computeStatus("connecting", 0).busy).toBe(true);
    expect(computeStatus("reconnecting", 5).busy).toBe(true);
    expect(computeStatus("closed", 5).busy).toBe(false);
    expect(computeStatus("open", 5).busy).toBe(false);
  });
});
