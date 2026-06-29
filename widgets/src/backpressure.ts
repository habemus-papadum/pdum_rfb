// Pure ACK / keyframe-gate / latest-frame-wins logic, extracted from the worker
// so it can be unit-tested without a browser.

import type { AckMsg } from "./protocol";

export interface BackpressureConfig {
  maxInflight: number;
  slowDownQueue: number;
  keyframeOnDropQueue: number;
}

const DEFAULTS: BackpressureConfig = {
  maxInflight: 3,
  slowDownQueue: 3,
  keyframeOnDropQueue: 6,
};

export class BackpressureController {
  private cfg: BackpressureConfig;
  private queued: number[] = [];

  constructor(cfg: Partial<BackpressureConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  onQueued(seq: number): void {
    this.queued.push(seq);
  }

  /** Mark the oldest queued frame as displayed; returns its seq (or undefined). */
  onDisplayed(): number | undefined {
    return this.queued.shift();
  }

  get inflight(): number {
    return this.queued.length;
  }

  buildAck(seq: number, decodeQueueSize: number, displayed = false): AckMsg {
    return { type: "ack", seq, decode_queue_size: decodeQueueSize, displayed };
  }

  shouldSlowDown(decodeQueueSize: number): boolean {
    return decodeQueueSize > this.cfg.slowDownQueue;
  }

  shouldRequestKeyframe(decodeQueueSize: number): boolean {
    return decodeQueueSize > this.cfg.keyframeOnDropQueue;
  }

  reset(): void {
    this.queued = [];
  }
}

/** Gates delta chunks until the first keyframe after connect/reset/reconfigure. */
export class KeyframeGate {
  private armed = true; // true => still waiting for a keyframe

  needsKeyframe(): boolean {
    return this.armed;
  }

  /** Returns true if this chunk may be decoded; false => drop it. */
  accept(isKeyframe: boolean): boolean {
    if (this.armed) {
      if (!isKeyframe) return false;
      this.armed = false;
    }
    return true;
  }

  reset(): void {
    this.armed = true;
  }
}
