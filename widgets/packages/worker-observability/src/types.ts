// Shared, dependency-free types + message shapes for the worker⇄main observability
// bridge. Pure: no `window`, `self`, or DOM/WebWorker globals are referenced here, so this
// module compiles under any lib and is trivially unit-testable in Node.

/** Log tiers, mirroring a conventional three-level logger:
 *  - `error` — always emitted (a genuine failure).
 *  - `notice` — a rare, actionable lifecycle event; on by default.
 *  - `log` — verbose per-frame play-by-play; off unless debug is enabled. */
export type LogLevel = "log" | "notice" | "error";

/** One forwarded log line as it travels worker → main and lands in the ring buffer. */
export interface LogLine {
  level: LogLevel;
  /** Emitter tag, e.g. `"rfb:worker"`. Rendered as `[tag]` when re-consoled on main. */
  tag: string;
  /** Sub-topic within the emitter, e.g. `"frame"` / `"ws"` / `"hb"`. */
  category: string;
  /** The remaining `console.*` arguments (best-effort structured-clone-safe). */
  args: unknown[];
  /** `Date.now()` at emit time (in the emitting realm). */
  t: number;
}

/** The discriminant marker present on every observability control message. A host can
 *  demultiplex these from its own worker traffic by testing for it. */
export const OBS_MARKER = "__workerObs" as const;

/** worker → main: a single forwarded log line. */
export interface WorkerLogMessage {
  [OBS_MARKER]: true;
  /** Namespace/channel (e.g. `"rfb"`), so multiple independent bridges don't cross-talk. */
  channel: string;
  kind: "log";
  line: LogLine;
}

/** main → worker: flip the worker's verbose logging at runtime. */
export interface SetDebugMessage {
  [OBS_MARKER]: true;
  channel: string;
  kind: "set_debug";
  debug: boolean;
}

/** Messages posted by the worker side of the bridge. */
export type WorkerObsMessage = WorkerLogMessage;
/** Messages posted by the main side of the bridge. */
export type MainObsMessage = SetDebugMessage;

function isMarked(m: unknown): m is { [OBS_MARKER]: true; channel: string; kind: string } {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as Record<string, unknown>)[OBS_MARKER] === true &&
    typeof (m as Record<string, unknown>).channel === "string"
  );
}

/** Type guard: is `m` a worker→main log message (optionally for a specific `channel`)? */
export function isWorkerObsMessage(m: unknown, channel?: string): m is WorkerLogMessage {
  return isMarked(m) && m.kind === "log" && (channel === undefined || m.channel === channel);
}

/** Type guard: is `m` a main→worker control message (optionally for a specific `channel`)? */
export function isMainObsMessage(m: unknown, channel?: string): m is SetDebugMessage {
  return isMarked(m) && m.kind === "set_debug" && (channel === undefined || m.channel === channel);
}
