import { describe, expect, it } from "vitest";

import { installWorkerObservability } from "@habemus-papadum/worker-observability/worker";
import { getRegistry, registerObservable } from "@habemus-papadum/worker-observability/main";
import type { WorkerLogMessage } from "@habemus-papadum/worker-observability";

// Proves the CONTRACT the rfb views + worker wire up (RemoteFramebufferView / MainThreadPresentView
// register on `window.__rfb`; worker/entry installs the forwarding logger + set_debug handler),
// exercised at the library seam with the exact channel/tags rfb uses — deterministic, no DOM.
// The real DOM/worker round-trip is covered by tests/e2e/observability.spec.ts.

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

/** Wire a worker-side bridge to a main-side registry instance the way a host does with
 *  `worker.onmessage → obs.ingest` and `postToWorker → worker.handleMessage`. */
function wireRfb(target: Record<string, unknown>) {
  const { con } = fakeConsole();
  const toWorker: unknown[] = [];
  const inst = registerObservable({
    channel: "rfb",
    name: "view",
    console: con,
    target,
    debug: false,
    postToWorker: (m) => toWorker.push(m),
    snapshots: { state: () => "open", stats: () => ({ framesDisplayed: 1 }) },
  });
  const worker = installWorkerObservability({
    channel: "rfb",
    tag: "rfb:worker",
    debug: false,
    localConsole: false,
    post: (m: WorkerLogMessage) => inst.ingest(m),
  });
  const drainToWorker = () => toWorker.splice(0).forEach((m) => worker.handleMessage(m));
  return { inst, worker, drainToWorker, con };
}

describe("rfb observability wiring", () => {
  it("worker logs reach window.__rfb.logs and the registry snapshots are live", () => {
    const target: Record<string, unknown> = {};
    const { worker } = wireRfb(target);

    worker.logger.notice("ws", "open"); // notice → forwarded by default
    worker.logger.error("decode", "boom"); // error → always forwarded

    const reg = getRegistry("rfb", target)!;
    expect(reg.logs.map((l) => `${l.tag}:${l.category}`)).toEqual(["rfb:worker:ws", "rfb:worker:decode"]);
    expect(reg.state()).toBe("open");
    expect(reg.stats()).toEqual({ framesDisplayed: 1 });
    // The handle is discoverable + self-describing.
    expect(reg.help()).toContain("__rfb");
  });

  it("window.__rfb.setDebug(true) toggles the worker at runtime and unlocks the verbose stream", () => {
    const target: Record<string, unknown> = {};
    const { worker, drainToWorker } = wireRfb(target);
    const reg = getRegistry("rfb", target)!;

    worker.logger.log("frame", { seq: 1 }); // verbose, gated off
    expect(reg.logs).toHaveLength(0);
    expect(worker.debug).toBe(false);

    reg.setDebug(true); // the `window.__rfb.setDebug(true)` an agent types
    drainToWorker(); // deliver the posted set_debug to the worker
    expect(worker.debug).toBe(true);

    worker.logger.log("frame", { seq: 2 });
    expect(reg.logs.map((l) => l.category)).toEqual(["frame"]); // now flowing

    reg.setDebug(false);
    drainToWorker();
    worker.logger.log("frame", { seq: 3 });
    expect(reg.logs).toHaveLength(1); // gated again
  });

  it("the heartbeat forwards a single summary line (not per-frame) once flowing", () => {
    const target: Record<string, unknown> = {};
    const forwarded: WorkerLogMessage[] = [];
    const inst = registerObservable({ channel: "rfb", target, console: fakeConsole().con, debug: true });
    let tick: (() => void) | null = null;
    const worker = installWorkerObservability({
      channel: "rfb",
      tag: "rfb:worker",
      debug: true,
      localConsole: false,
      post: (m: WorkerLogMessage) => {
        forwarded.push(m);
        inst.ingest(m);
      },
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => {},
    });
    let displayed = 0;
    const stop = worker.startHeartbeat(() => (displayed > 0 ? `fps 10.0 displayed ${displayed}` : null), 5000);
    tick!(); // idle → nothing
    displayed = 10;
    tick!(); // flowing → one heartbeat line
    expect(forwarded.filter((m) => m.line.category === "hb")).toHaveLength(1);
    const reg = getRegistry("rfb", target)!;
    expect(reg.logs.some((l) => l.category === "hb" && String(l.args[0]).includes("fps 10.0"))).toBe(true);
    stop();
  });
});
