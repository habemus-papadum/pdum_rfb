import { describe, expect, it, vi } from "vitest";

import { installWorkerObservability } from "../src/workerObservability";
import {
  OBS_MARKER,
  type WorkerLogMessage,
  isMainObsMessage,
  isWorkerObsMessage,
} from "../src/types";

/** A console double capturing (method, prefix, ...args) per call. */
function fakeConsole() {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    con: {
      debug: (...args: unknown[]) => calls.push({ method: "debug", args }),
      info: (...args: unknown[]) => calls.push({ method: "info", args }),
      error: (...args: unknown[]) => calls.push({ method: "error", args }),
    },
  };
}

describe("worker→main bridge message shape", () => {
  it("posts a well-formed WorkerLogMessage per emitted line", () => {
    const posted: WorkerLogMessage[] = [];
    const { con } = fakeConsole();
    const obs = installWorkerObservability({
      channel: "demo",
      tag: "demo:worker",
      debug: true,
      post: (m) => posted.push(m),
      console: con,
      now: () => 1234,
    });

    obs.logger.notice("ws", "open", { code: 1000 });
    obs.logger.log("frame", { seq: 7 });
    obs.logger.error("decode", new Error("boom"));

    expect(posted).toHaveLength(3);
    for (const m of posted) {
      expect(m[OBS_MARKER]).toBe(true);
      expect(m.channel).toBe("demo");
      expect(m.kind).toBe("log");
      expect(isWorkerObsMessage(m, "demo")).toBe(true);
      expect(isWorkerObsMessage(m, "other")).toBe(false);
    }
    expect(posted[0].line).toMatchObject({ level: "notice", tag: "demo:worker", category: "ws", t: 1234 });
    expect(posted[0].line.args).toEqual(["open", { code: 1000 }]);
    expect(posted[1].line.level).toBe("log");
    expect(posted[2].line.level).toBe("error");
  });

  it("gates the verbose tier: no forward for log() until debug is on", () => {
    const posted: WorkerLogMessage[] = [];
    const { con } = fakeConsole();
    const obs = installWorkerObservability({
      channel: "demo",
      tag: "t",
      debug: false,
      post: (m) => posted.push(m),
      console: con,
    });

    obs.logger.log("frame", 1); // gated off
    obs.logger.notice("ws", "open"); // notices forwarded by default
    expect(posted.map((p) => p.line.category)).toEqual(["ws"]);

    // A runtime set_debug (as if from main) unlocks the verbose tier.
    obs.handleMessage({ [OBS_MARKER]: true, channel: "demo", kind: "set_debug", debug: true });
    obs.logger.log("frame", 2);
    expect(posted.map((p) => p.line.category)).toEqual(["ws", "frame"]);
    expect(obs.debug).toBe(true);
  });

  it("ignores foreign / mismatched-channel control messages", () => {
    const obs = installWorkerObservability({ channel: "demo", tag: "t", debug: false, post: () => {} });
    expect(obs.handleMessage({ hello: 1 })).toBe(false);
    expect(obs.handleMessage({ [OBS_MARKER]: true, channel: "other", kind: "set_debug", debug: true })).toBe(false);
    expect(obs.debug).toBe(false);
    expect(obs.handleMessage({ [OBS_MARKER]: true, channel: "demo", kind: "set_debug", debug: true })).toBe(true);
    expect(obs.debug).toBe(true);
  });

  it("falls back to stringified args when postMessage rejects the clone", () => {
    const posted: WorkerLogMessage[] = [];
    let thrownOnce = false;
    const obs = installWorkerObservability({
      channel: "demo",
      tag: "t",
      debug: true,
      post: (m) => {
        // Simulate a DataCloneError on the first (rich-arg) attempt only.
        if (!thrownOnce && typeof m.line.args[0] === "function") {
          thrownOnce = true;
          throw new Error("DataCloneError"); // stand-in for a structured-clone rejection
        }
        posted.push(m);
      },
    });
    obs.logger.error("oops", () => 42);
    expect(posted).toHaveLength(1);
    expect(typeof posted[0].line.args[0]).toBe("string"); // stringified fallback
  });

  it("heartbeat emits summaries on an injected timer, skipping null (idle)", () => {
    const posted: WorkerLogMessage[] = [];
    let tick: (() => void) | null = null;
    const obs = installWorkerObservability({
      channel: "demo",
      tag: "t",
      debug: true,
      post: (m) => posted.push(m),
      localConsole: false,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: vi.fn(),
    });
    let flowing = false;
    const stop = obs.startHeartbeat(() => (flowing ? "fps 10.0 displayed 5" : null), 5000);
    tick!(); // idle → no line
    expect(posted).toHaveLength(0);
    flowing = true;
    tick!(); // flowing → one heartbeat line
    expect(posted).toHaveLength(1);
    expect(posted[0].line.category).toBe("hb");
    stop();
  });
});

describe("message guards", () => {
  it("isMainObsMessage discriminates set_debug", () => {
    expect(isMainObsMessage({ [OBS_MARKER]: true, channel: "x", kind: "set_debug", debug: true }, "x")).toBe(true);
    expect(isMainObsMessage({ [OBS_MARKER]: true, channel: "x", kind: "log" }, "x")).toBe(false);
    expect(isMainObsMessage(null)).toBe(false);
    expect(isMainObsMessage(42)).toBe(false);
  });
});
