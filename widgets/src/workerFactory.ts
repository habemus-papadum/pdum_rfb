// Default worker construction. `?worker&inline` makes Vite bundle the worker
// (and all its imports) self-contained into the published library, so any
// downstream bundler — or none — works with zero worker configuration.
import RfbWorker from "./worker/entry?worker&inline";

export function createInlineWorker(): Worker {
  return new RfbWorker();
}
