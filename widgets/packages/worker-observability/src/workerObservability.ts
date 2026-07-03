// Worker side of the bridge. A worker's `console.*` is invisible to the Chrome MCP browser
// tools (and, for a plain page, to anything watching the main thread), so everything an agent
// needs to see must reach the main thread. `installWorkerObservability` gives the worker a
// stable logger that FORWARDS each emitted line to main, a `set_debug` control handler (flip
// verbosity at runtime with no rebuild), and a cadence heartbeat helper (one periodic summary
// line instead of per-frame spam).
//
// `post` is injected (the caller binds `self.postMessage`), and the timer + console + clock
// are injectable too, so this module references no worker-only globals and unit-tests in Node.

import { buildLogger, type ConsoleLike, type Logger, MutableLogger, toPlainArgs } from "./logger";
import { OBS_MARKER, type LogLine, type WorkerLogMessage, isMainObsMessage } from "./types";

export interface InstallWorkerOptions {
  /** Namespace shared with the main-side registry (e.g. `"rfb"`). */
  channel: string;
  /** Emitter tag, e.g. `"rfb:worker"`. */
  tag: string;
  /** Initial verbose-logging state. */
  debug: boolean;
  /** Enable the `notice()` tier (default on). */
  notice?: boolean;
  /** Post a message to the main thread (bind `self.postMessage`). */
  post: (msg: WorkerLogMessage) => void;
  /** Also write lines to the worker's own console (default on). */
  localConsole?: boolean;
  console?: ConsoleLike;
  now?: () => number;
  /** Timer primitives (default `globalThis`) — injectable for deterministic heartbeat tests. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface WorkerObservability {
  /** A stable logger; keep this reference — `setDebug()` swaps its behaviour underneath. */
  readonly logger: Logger;
  /** Current verbose-logging state. */
  readonly debug: boolean;
  /** Rebuild the logger with a new verbose flag (also invoked on a `set_debug` message). */
  setDebug(debug: boolean): void;
  /** Consume an observability control message from main. Returns true if it was ours. */
  handleMessage(msg: unknown): boolean;
  /** Emit `summary()` every `intervalMs` (default 5000) on the verbose tier; a `null` summary
   *  is skipped (stay quiet when idle). Returns a stop function. */
  startHeartbeat(summary: () => string | null, intervalMs?: number): () => void;
}

export function installWorkerObservability(opts: InstallWorkerOptions): WorkerObservability {
  const { channel, tag, post } = opts;
  const notice = opts.notice ?? true;
  const localConsole = opts.localConsole ?? true;
  const con = opts.console;
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIntervalFn = opts.clearInterval ?? ((h) => globalThis.clearInterval(h as never));

  // Forward every emitted line to main. If the args aren't structured-clone-safe, retry with a
  // stringified copy so a rich log arg never wedges the bridge.
  const forward = (line: LogLine): void => {
    const msg: WorkerLogMessage = { [OBS_MARKER]: true, channel, kind: "log", line };
    try {
      post(msg);
    } catch {
      post({ ...msg, line: { ...line, args: toPlainArgs(line.args) } });
    }
  };

  const make = (debug: boolean): Logger =>
    buildLogger({ tag, debug, notice, localConsole, console: con, now, onLine: forward });

  let debug = opts.debug;
  const mutable = new MutableLogger(make(debug));

  const setDebug = (next: boolean): void => {
    debug = next;
    mutable.set(make(next));
  };

  return {
    logger: mutable,
    get debug() {
      return debug;
    },
    setDebug,
    handleMessage(msg: unknown): boolean {
      if (isMainObsMessage(msg, channel)) {
        setDebug(msg.debug);
        return true;
      }
      return false;
    },
    startHeartbeat(summary: () => string | null, intervalMs = 5000): () => void {
      const handle = setIntervalFn(() => {
        const s = summary();
        if (s !== null) mutable.log("hb", s);
      }, intervalMs);
      return () => clearIntervalFn(handle);
    },
  };
}
