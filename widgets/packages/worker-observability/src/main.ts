// Main-thread entry: import this on the MAIN thread. Installs / reads the `window.__<ns>`
// registry and reads the opt-in debug flag from the URL / localStorage.

export {
  getRegistry,
  readDebugFlag,
  registerObservable,
  type ObsInstance,
  type ObsRegistry,
  type RegisterOptions,
  type SnapshotProvider,
} from "./registry";
export { type Logger } from "./logger";
export { type LogLine, type MainObsMessage } from "./types";
