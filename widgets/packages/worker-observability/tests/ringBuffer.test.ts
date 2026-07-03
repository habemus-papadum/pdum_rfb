import { describe, expect, it } from "vitest";

import { RingBuffer } from "../src/ringBuffer";

describe("RingBuffer", () => {
  it("keeps items in order until full", () => {
    const rb = new RingBuffer<number>(4);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
  });

  it("evicts the oldest once at capacity (bounded)", () => {
    const rb = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) rb.push(n);
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]); // oldest → newest, 1 & 2 dropped
  });

  it("stays oldest→newest across many wraps", () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 0; i < 100; i++) rb.push(i);
    expect(rb.toArray()).toEqual([97, 98, 99]);
  });

  it("clears", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });

  it("clamps a non-positive capacity to 1", () => {
    const rb = new RingBuffer<number>(0);
    rb.push(1);
    rb.push(2);
    expect(rb.toArray()).toEqual([2]);
  });
});
