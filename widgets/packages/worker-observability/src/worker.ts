// Worker-side entry: import this INSIDE a Web Worker. Worker-safe (references no
// `window`/`localStorage`), so it typechecks under the WebWorker lib.

export { installWorkerObservability, type InstallWorkerOptions, type WorkerObservability } from "./workerObservability";
export { buildLogger, type Logger, MutableLogger } from "./logger";
export { OBS_MARKER, isMainObsMessage, type LogLine, type WorkerLogMessage } from "./types";
