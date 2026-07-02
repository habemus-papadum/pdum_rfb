import { describe, expect, it } from "vitest";

import { isPermanentClose, RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelay } from "../../src/reconnect";

describe("reconnectDelay", () => {
  it("grows exponentially with the attempt (using the ceiling, rand=1)", () => {
    const ceil = (n: number) => reconnectDelay(n, () => 1);
    expect(ceil(0)).toBe(RECONNECT_BASE_MS);
    expect(ceil(1)).toBe(RECONNECT_BASE_MS * 2);
    expect(ceil(2)).toBe(RECONNECT_BASE_MS * 4);
  });

  it("caps at RECONNECT_MAX_MS no matter how many attempts", () => {
    for (const n of [5, 10, 50, 1000]) {
      expect(reconnectDelay(n, () => 1)).toBe(RECONNECT_MAX_MS);
    }
  });

  it("applies full jitter: every delay lies in [ceil/2, ceil]", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ceil = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const d = reconnectDelay(attempt, () => r);
        expect(d).toBeGreaterThanOrEqual(Math.round(ceil * 0.5));
        expect(d).toBeLessThanOrEqual(ceil);
      }
    }
  });

  it("treats negative attempts as attempt 0 (no blow-up)", () => {
    expect(reconnectDelay(-3, () => 1)).toBe(RECONNECT_BASE_MS);
  });
});

describe("isPermanentClose", () => {
  it("does not retry deliberate server rejects (auth 4401, unknown-stream 4404)", () => {
    expect(isPermanentClose(4401)).toBe(true);
    expect(isPermanentClose(4404)).toBe(true);
  });

  it("retries transient closes (abnormal 1006, going-away 1001, normal 1000)", () => {
    for (const code of [1000, 1001, 1005, 1006, 1011, 4500]) {
      expect(isPermanentClose(code)).toBe(false);
    }
  });
});
