// @habemus-papadum/worker-observability — make a Web Worker's internals observable from the
// main thread (and thus from agentic browser tooling that can't see worker `console.*`).
//
// Import from the side you need:
//   - `@habemus-papadum/worker-observability/worker` — inside the worker (log bridge + toggle
//     handler + heartbeat).
//   - `@habemus-papadum/worker-observability/main` — on the main thread (`window.__<ns>`
//     registry, ring buffer, snapshots, runtime debug toggle, `readDebugFlag`).
//
// The root export is the framework-agnostic, DOM/WebWorker-neutral core (types + ring buffer +
// logger + message guards), safe to import from either realm.

export { RingBuffer } from "./ringBuffer";
export {
  buildLogger,
  consoleMethod,
  formatPrefix,
  type BuildLoggerOptions,
  type ConsoleLike,
  type Logger,
  MutableLogger,
  toPlainArgs,
} from "./logger";
export {
  OBS_MARKER,
  isMainObsMessage,
  isWorkerObsMessage,
  type LogLevel,
  type LogLine,
  type MainObsMessage,
  type SetDebugMessage,
  type WorkerLogMessage,
  type WorkerObsMessage,
} from "./types";
