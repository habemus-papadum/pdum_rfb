import { describe, expect, it, vi } from "vitest";

import { getRegistry, readDebugFlag, registerObservable } from "../src/registry";
import { installWorkerObservability } from "../src/workerObservability";
import { type WorkerLogMessage, isMainObsMessage } from "../src/types";

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

describe("registry install + snapshots", () => {
  it("installs window.__<ns>, registers instances, exposes snapshots + a discoverability line", () => {
    const target: Record<string, unknown> = {};
    const { con, calls } = fakeConsole();
    let stateVal = "connecting";
    const inst = registerObservable({
      channel: "rfb",
      name: "view",
      console: con,
      target,
      snapshots: {
        state: () => stateVal,
        stats: () => ({ framesDisplayed: 3 }),
        surface: () => "2d",
        capture: () => (fmt: string) => `captured:${fmt}`,
      },
    });

    const reg = getRegistry("rfb", target)!;
    expect(reg).toBeDefined();
    expect(reg.ns).toBe("rfb");
    expect(reg.instances).toContain(inst);
    expect(reg.view).toBe(inst);
    expect(reg.state()).toBe("connecting");
    stateVal = "open";
    expect(reg.state()).toBe("open"); // live provider, not a snapshot value
    expect(reg.stats()).toEqual({ framesDisplayed: 3 });
    expect(reg.surface()).toBe("2d");
    expect(reg.capture("png")).toBe("captured:png");

    // Exactly one discoverability notice on first creation, naming the handle.
    const notices = calls.filter((c) => c.method === "info" && String(c.args[0]).includes("observability"));
    expect(notices).toHaveLength(1);
    expect(String(notices[0].args[0])).toContain("__rfb");
  });

  it("deregisters instances but keeps the registry handle alive across a rebuild", () => {
    const target: Record<string, unknown> = {};
    const { con } = fakeConsole();
    const a = registerObservable({ channel: "rfb", console: con, target });
    const b = registerObservable({ channel: "rfb", console: con, target });
    expect(getRegistry("rfb", target)!.instances).toHaveLength(2);
    a.dispose();
    expect(getRegistry("rfb", target)!.instances).toEqual([b]);
    b.dispose();
    // The registry persists (stable handle for reparent-heavy hosts), just with no instances.
    const reg = getRegistry("rfb", target);
    expect(reg).toBeDefined();
    expect(reg!.instances).toHaveLength(0);
    // A re-registration reuses the SAME registry object (no second discoverability notice).
    const c = registerObservable({ channel: "rfb", console: con, target });
    expect(getRegistry("rfb", target)).toBe(reg);
    expect(reg!.view).toBe(c);
  });
});

describe("worker→main round-trip (the whole point)", () => {
  it("forwarded worker logs reach window.__rfb.logs and re-console on main", () => {
    const target: Record<string, unknown> = {};
    const { con: mainCon, calls: mainCalls } = fakeConsole();
    const { con: workerCon } = fakeConsole();

    // Wire the worker's post() straight into the main instance's ingest() — the transport a
    // real host implements via worker.onmessage.
    const inst = registerObservable({ channel: "rfb", name: "view", console: mainCon, target, reConsole: true });
    const worker = installWorkerObservability({
      channel: "rfb",
      tag: "rfb:worker",
      debug: false,
      console: workerCon,
      post: (m: WorkerLogMessage) => inst.ingest(m),
    });

    worker.logger.notice("ws", "open");
    worker.logger.log("frame", { seq: 1 }); // gated off (debug false) → not forwarded

    const reg = getRegistry("rfb", target)!;
    expect(reg.logs.map((l) => l.category)).toEqual(["ws"]);
    // The forwarded worker line was re-consoled on the MAIN thread (readable by main-only tools).
    const reconsoled = mainCalls.filter((c) => String(c.args[0]).includes("[rfb:worker] ws"));
    expect(reconsoled).toHaveLength(1);
    expect(reconsoled[0].method).toBe("info"); // notice → console.info
  });

  it("setDebug on the registry toggles the worker at runtime (posts set_debug) and unlocks logs", () => {
    const target: Record<string, unknown> = {};
    const { con: mainCon } = fakeConsole();
    const toWorker: unknown[] = [];

    const inst = registerObservable({
      channel: "rfb",
      name: "view",
      console: mainCon,
      target,
      postToWorker: (m) => toWorker.push(m),
    });
    // The worker consumes whatever main posts to it.
    const worker = installWorkerObservability({
      channel: "rfb",
      tag: "rfb:worker",
      debug: false,
      localConsole: false,
      post: (m: WorkerLogMessage) => inst.ingest(m),
    });
    const drainToWorker = () => toWorker.splice(0).forEach((m) => worker.handleMessage(m));

    const reg = getRegistry("rfb", target)!;

    worker.logger.log("frame", 1);
    drainToWorker();
    expect(reg.logs).toHaveLength(0); // verbose still gated

    reg.setDebug(true); // console handle → runtime toggle
    expect(toWorker).toHaveLength(1);
    expect(isMainObsMessage(toWorker[0], "rfb")).toBe(true);
    drainToWorker();

    worker.logger.log("frame", 2);
    expect(reg.logs.map((l) => l.category)).toEqual(["frame"]); // now flowing
    expect(worker.debug).toBe(true);

    reg.setDebug(false);
    drainToWorker();
    worker.logger.log("frame", 3);
    expect(reg.logs).toHaveLength(1); // gated again — the earlier "frame 2" only
  });

  it("a main-thread minted logger records into the ring AND rebuilds on setDebug", () => {
    const target: Record<string, unknown> = {};
    const { con, calls } = fakeConsole();
    const inst = registerObservable({ channel: "rfb", console: con, target, debug: false });
    const log = inst.makeLogger("rfb:view", { notice: true });

    log.log("state", "connecting"); // verbose, gated off initially
    expect(inst.logs()).toHaveLength(0);

    inst.setDebug(true);
    log.log("state", "open"); // same logger reference now verbose
    expect(inst.logs().map((l) => l.category)).toEqual(["state"]);
    expect(calls.some((c) => c.method === "debug" && String(c.args[0]).includes("[rfb:view] state"))).toBe(true);
  });
});

describe("readDebugFlag", () => {
  it("reads ?debug=1 / ?<name>Debug=1 and localStorage, else false", () => {
    expect(readDebugFlag("rfb", { location: { search: "?debug=1" } })).toBe(true);
    expect(readDebugFlag("rfb", { location: { search: "?rfbDebug=1" } })).toBe(true);
    expect(readDebugFlag("rfb", { location: { search: "?x=1" } })).toBe(false);
    expect(readDebugFlag("rfb", { localStorage: { getItem: (k: string) => (k === "rfbDebug" ? "1" : null) } } as never)).toBe(true);
    expect(readDebugFlag("rfb", {})).toBe(false);
  });

  it("never throws when globals are absent (worker-ish realm)", () => {
    const spy = vi.fn(readDebugFlag);
    expect(() => spy("rfb", {})).not.toThrow();
  });
});
