// A three-tier logger (error / notice / log) with a pluggable emit sink, plus a mutable
// facade whose backing logger can be swapped at runtime (the mechanism behind a live debug
// toggle). Nothing here references `window` or `self`; the console + clock are injectable, so
// the whole module is testable in Node.

import type { LogLevel, LogLine } from "./types";

/** The public logger surface. Structurally identical to a conventional tagged logger, so a
 *  host can drop it in wherever it already threads a `{ log, notice, error }` around. */
export interface Logger {
  /** Whether the verbose `log()` tier is currently enabled. */
  readonly enabled: boolean;
  /** Verbose per-frame play-by-play — emitted only when debug is on. */
  log(category: string, ...args: unknown[]): void;
  /** A rare, actionable lifecycle event — emitted unless notices are disabled. */
  notice(category: string, ...args: unknown[]): void;
  /** A genuine failure — always emitted, regardless of the other tiers. */
  error(category: string, ...args: unknown[]): void;
}

/** The subset of `console` the logger uses (injectable for tests). */
export interface ConsoleLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface BuildLoggerOptions {
  /** Emitter tag, rendered as `[tag]`, e.g. `"rfb:worker"`. */
  tag: string;
  /** Enable the verbose `log()` tier (default off). */
  debug: boolean;
  /** Enable the `notice()` tier (default on). */
  notice?: boolean;
  /** Write emitted lines to a console (default on). Turn off to forward-only. */
  localConsole?: boolean;
  /** Called for every EMITTED line (after tier gating) — the forward/record hook. */
  onLine?: (line: LogLine) => void;
  /** Console to write to (default `globalThis.console`). */
  console?: ConsoleLike;
  /** Clock (default `Date.now`). */
  now?: () => number;
}

const noop = (): void => {};

/** Render the `[tag] category` prefix used when a line is (re-)written to a console. */
export function formatPrefix(line: Pick<LogLine, "tag" | "category">): string {
  return `[${line.tag}] ${line.category}`;
}

/** Map a tier to the console method that carries it. */
export function consoleMethod(c: ConsoleLike, level: LogLevel): (...args: unknown[]) => void {
  if (level === "error") return c.error.bind(c);
  if (level === "notice") return c.info.bind(c);
  return c.debug.bind(c);
}

/** Best-effort structured-clone-safe copy of a log arg (for the postMessage fallback). */
function toPlain(v: unknown): unknown {
  if (v === null) return v;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "undefined") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

/** Map every arg to a clone-safe form — used when a raw postMessage of the args throws. */
export function toPlainArgs(args: unknown[]): unknown[] {
  return args.map(toPlain);
}

/** Build a concrete logger. Each emitted line is optionally written to `console` AND handed
 *  to `onLine` (e.g. to postMessage it to the main thread and/or push it to a ring buffer). */
export function buildLogger(opts: BuildLoggerOptions): Logger {
  const { tag, debug, onLine } = opts;
  const notice = opts.notice ?? true;
  const localConsole = opts.localConsole ?? true;
  const con = opts.console ?? (globalThis.console as ConsoleLike);
  const now = opts.now ?? Date.now;

  const emit = (level: LogLevel, category: string, args: unknown[]): void => {
    if (localConsole) consoleMethod(con, level)(`[${tag}] ${category}`, ...args);
    if (onLine) onLine({ level, tag, category, args, t: now() });
  };

  return {
    enabled: debug,
    log: debug ? (category, ...args) => emit("log", category, args) : noop,
    notice: notice ? (category, ...args) => emit("notice", category, args) : noop,
    error: (category, ...args) => emit("error", category, args),
  };
}

/** A stable logger facade whose backing logger can be swapped at runtime. Callers hold ONE
 *  reference forever; `set()` (driven by a debug toggle) changes behaviour under them without
 *  them having to re-fetch a logger. */
export class MutableLogger implements Logger {
  private inner: Logger;
  constructor(initial: Logger) {
    this.inner = initial;
  }
  get enabled(): boolean {
    return this.inner.enabled;
  }
  log(category: string, ...args: unknown[]): void {
    this.inner.log(category, ...args);
  }
  notice(category: string, ...args: unknown[]): void {
    this.inner.notice(category, ...args);
  }
  error(category: string, ...args: unknown[]): void {
    this.inner.error(category, ...args);
  }
  /** Replace the backing logger (e.g. rebuilt with a new debug flag). */
  set(inner: Logger): void {
    this.inner = inner;
  }
}
