// Main side of the bridge. Installs a discoverable registry at `window.__<ns>` (or any target
// object) that:
//   - holds a bounded ring buffer of forwarded worker log lines (`.logs`), re-`console.*`ing
//     each as it arrives so it is readable by tools that only see the main thread;
//   - exposes pluggable state snapshots (`.state()`, `.stats()`, `.surface()`, `.capture()`,
//     and any host-supplied fields) so a live instance can be interrogated from the console;
//   - flips debug at runtime (`.setDebug(true)` → posts `set_debug` to each worker AND rebuilds
//     the main-thread loggers it minted), with no rebuild or restart.
//
// `target` + `console` are injectable, so the whole registry unit-tests in Node without a DOM.

import { buildLogger, type ConsoleLike, consoleMethod, formatPrefix, type Logger, MutableLogger } from "./logger";
import { RingBuffer } from "./ringBuffer";
import { type LogLine, type MainObsMessage, OBS_MARKER, isWorkerObsMessage } from "./types";

/** A named snapshot provider — returns whatever the host wants exposed (sync or a Promise). */
export type SnapshotProvider = () => unknown;

export interface RegisterOptions {
  /** Namespace → the registry is installed at `target["__" + channel]`. */
  channel: string;
  /** A short, human-facing instance name (shown in the discoverability notice + `.instances`). */
  name?: string;
  /** Initial verbose-logging state (seeds `makeLogger` + the toggle bookkeeping). */
  debug?: boolean;
  /** Post a control message to THIS instance's worker (bind `worker.postMessage`). Read lazily
   *  so it can target a worker that is rebuilt after registration. */
  postToWorker?: (msg: MainObsMessage) => void;
  /** Also invoked on `setDebug()`, in case the host wants to flip something beyond its minted
   *  loggers (usually unnecessary — minted loggers rebuild automatically). */
  onSetDebug?: (debug: boolean) => void;
  /** Named state snapshots exposed on the registry (`state`/`stats`/`surface`/`capture`/…). */
  snapshots?: Record<string, SnapshotProvider>;
  /** Ring-buffer capacity for forwarded log lines (default 500). */
  logCapacity?: number;
  /** Re-`console.*` each forwarded worker line on the main thread (default on) so tools that
   *  only see the main thread can read the worker's stream. */
  reConsole?: boolean;
  console?: ConsoleLike;
  now?: () => number;
  /** Where to install the registry (default `globalThis`). */
  target?: Record<string, unknown>;
}

/** A registered instance: one view/worker pair's slice of the registry. */
export interface ObsInstance {
  readonly name: string;
  readonly channel: string;
  /** Current verbose-logging state. */
  readonly debug: boolean;
  /** Ingest a message from the worker; records + re-consoles a forwarded log line and returns
   *  true, or returns false for anything that isn't ours (so the host keeps handling it). */
  ingest(msg: unknown): boolean;
  /** Push a line into this instance's ring buffer directly (e.g. a main-thread logger line). */
  record(line: LogLine): void;
  /** Forwarded (and recorded) log lines, oldest → newest. */
  logs(): LogLine[];
  /** Flip verbose logging: rebuild the loggers this instance minted AND post `set_debug` to the
   *  worker. Idempotent; safe to call from the console. */
  setDebug(debug: boolean): void;
  /** A main-thread logger that consoles AND records into this instance's ring buffer. Rebuilt
   *  automatically by `setDebug()`. */
  makeLogger(tag: string, opts?: { notice?: boolean }): Logger;
  /** Read a named snapshot provider (undefined if none registered). */
  snapshot(key: string): unknown;
  /** Deregister; removes the instance and (when the last one goes) tears the registry down. */
  dispose(): void;
}

/** The object installed at `window.__<ns>`. */
export interface ObsRegistry {
  readonly ns: string;
  readonly instances: ObsInstance[];
  /** The sole / first instance (the common single-widget case). */
  readonly view: ObsInstance | undefined;
  /** All instances' forwarded log lines, merged oldest → newest. */
  readonly logs: LogLine[];
  state(): unknown;
  stats(): unknown;
  surface(): unknown;
  capture(...args: unknown[]): unknown;
  /** Flip verbose logging across every registered instance. */
  setDebug(debug: boolean): void;
  /** A one-line reminder of what's available here. */
  help(): string;
  /** @internal */
  __register(inst: ObsInstance): void;
  /** @internal */
  __deregister(inst: ObsInstance): void;
}

const registryKey = (channel: string): string => `__${channel}`;

/** Fetch the already-installed registry for a channel, if any. */
export function getRegistry(channel: string, target: Record<string, unknown> = globalThis as never): ObsRegistry | undefined {
  return target[registryKey(channel)] as ObsRegistry | undefined;
}

function firstProvider(reg: ObsRegistry, key: string): unknown {
  return reg.instances[0]?.snapshot(key);
}

function ensureRegistry(channel: string, target: Record<string, unknown>, con: ConsoleLike): ObsRegistry {
  const existing = getRegistry(channel, target);
  if (existing) return existing;

  const instances: ObsInstance[] = [];
  const reg: ObsRegistry = {
    ns: channel,
    instances,
    get view() {
      return instances[0];
    },
    get logs() {
      // Merge every instance's lines, ordered by emit time.
      return instances
        .flatMap((i) => i.logs())
        .sort((a, b) => a.t - b.t);
    },
    state: () => firstProvider(reg, "state"),
    stats: () => firstProvider(reg, "stats"),
    surface: () => firstProvider(reg, "surface"),
    capture: (...args: unknown[]) => {
      const provider = instances[0]?.snapshot("capture");
      // A capture provider is typically a function of the format; call it if callable.
      return typeof provider === "function" ? (provider as (...a: unknown[]) => unknown)(...args) : provider;
    },
    setDebug: (debug: boolean) => instances.forEach((i) => i.setDebug(debug)),
    help: () =>
      `window.${registryKey(channel)} — .setDebug(true|false), .logs, .state(), .stats(), .surface(), .capture(), .instances`,
    __register(inst) {
      instances.push(inst);
    },
    __deregister(inst) {
      const i = instances.indexOf(inst);
      if (i >= 0) instances.splice(i, 1);
      // The registry object itself PERSISTS even when empty: embedding hosts (marimo, an SPA
      // route swap) dispose + recreate a view across a rebuild, and a stable `window.__<ns>`
      // handle survives that churn — plus `.logs` history outlives a single connection.
    },
  };
  target[registryKey(channel)] = reg;
  // One discoverability line on first creation — names the handle, doesn't spam.
  con.info(`[${channel}] worker observability at ${reg.help()}`);
  return reg;
}

export function registerObservable(opts: RegisterOptions): ObsInstance {
  const { channel } = opts;
  const con = opts.console ?? (globalThis.console as ConsoleLike);
  const target = opts.target ?? (globalThis as never as Record<string, unknown>);
  const reConsole = opts.reConsole ?? true;
  const now = opts.now ?? Date.now;
  const snapshots = opts.snapshots ?? {};
  const reg = ensureRegistry(channel, target, con);

  const ring = new RingBuffer<LogLine>(opts.logCapacity ?? 500);
  const mintedLoggers = new Set<MutableLogger>();
  const loggerNotices = new WeakMap<MutableLogger, boolean>();
  const loggerTags = new WeakMap<MutableLogger, string>();
  let debug = opts.debug ?? false;
  let disposed = false;

  const record = (line: LogLine): void => {
    ring.push(line);
  };

  const rebuildMinted = (): void => {
    for (const ml of mintedLoggers) {
      const tag = loggerTags.get(ml) ?? "";
      const notice = loggerNotices.get(ml) ?? true;
      ml.set(buildLogger({ tag, debug, notice, console: con, now, onLine: record }));
    }
  };

  const inst: ObsInstance = {
    name: opts.name ?? channel,
    channel,
    get debug() {
      return debug;
    },
    ingest(msg: unknown): boolean {
      if (!isWorkerObsMessage(msg, channel)) return false;
      record(msg.line);
      if (reConsole) consoleMethod(con, msg.line.level)(formatPrefix(msg.line), ...msg.line.args);
      return true;
    },
    record,
    logs: () => ring.toArray(),
    setDebug(next: boolean) {
      debug = next;
      rebuildMinted();
      opts.postToWorker?.({ [OBS_MARKER]: true, channel, kind: "set_debug", debug: next });
      opts.onSetDebug?.(next);
    },
    makeLogger(tag: string, o?: { notice?: boolean }): Logger {
      const notice = o?.notice ?? true;
      const ml = new MutableLogger(buildLogger({ tag, debug, notice, console: con, onLine: record, now }));
      loggerTags.set(ml, tag);
      loggerNotices.set(ml, notice);
      mintedLoggers.add(ml);
      return ml;
    },
    snapshot: (key: string) => snapshots[key]?.(),
    dispose() {
      if (disposed) return;
      disposed = true;
      mintedLoggers.clear();
      ring.clear();
      reg.__deregister(inst);
    },
  };
  reg.__register(inst);
  return inst;
}

/** Read an opt-in debug flag from the URL (`?<name>Debug=1` or `?debug=1`) or `localStorage`
 *  (`<name>Debug` / `rfbDebug`-style key). Main-thread only (no-ops if there's no `location`
 *  or `localStorage`). Lets a reload start verbose without touching code. */
export function readDebugFlag(name = "rfb", target: Record<string, unknown> = globalThis as never): boolean {
  try {
    const loc = (target as { location?: { search?: string } }).location;
    if (loc?.search) {
      const params = new URLSearchParams(loc.search);
      if (params.get(`${name}Debug`) === "1" || params.get("debug") === "1") return true;
    }
  } catch {
    /* no location */
  }
  try {
    const ls = (target as { localStorage?: { getItem(k: string): string | null } }).localStorage;
    const v = ls?.getItem(`${name}Debug`);
    if (v === "1" || v === "true") return true;
  } catch {
    /* no localStorage / access denied */
  }
  return false;
}
