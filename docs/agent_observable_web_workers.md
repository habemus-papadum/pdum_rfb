# Making Web Workers observable to agentic browser tools

A reusable set of principles — and a small drop-in library — for any web app that pushes heavy
compute into a **Web Worker** and wants an **agent** (driving a real browser through the Chrome
MCP / DevTools tools) to be able to *see inside* that worker. It is written to be orthogonal to
any one app; the running example is `pdum.rfb`'s decode worker, but nothing here is rfb-specific.

The lessons were paid for in a real bug: an OffscreenCanvas viewer rendered **black**, the
worker was decoding + drawing correctly the whole time, and the single richest log stream in the
client — the worker's `console.*` — was **invisible to the browser automation tools**. The fix
had to be found with ad-hoc `window.__x` hooks that were then thrown away. This doc is what those
hooks became: first-class, off-by-default, runtime-toggleable observability.

> **The library:** `@habemus-papadum/worker-observability` (in `widgets/packages/`) packages
> every pattern below. It is generic (framework- and app-agnostic) and private/experimental. rfb
> adopts it in `widgets/src/debug.ts`, `widgets/src/worker/entry.ts`,
> `widgets/src/RemoteFramebufferView.ts`, and `widgets/src/MainThreadPresentView.ts`.

---

## The hard constraint: a worker's `console.*` never reaches the agent

The browser MCP tool that reads the console (`read_console_messages` and friends) surfaces
**only main-thread / page** console output. A dedicated worker's `console.debug/info/error` runs
in a *separate realm* and does **not** appear there — even with verbose logging forced on. So the
one stream that would localize a worker bug is exactly the one the agent cannot read.

(Playwright's `page.on("console")` *does* happen to surface worker console in some setups, but you
cannot rely on that for the MCP tools an agent actually uses, and you certainly cannot rely on it
for a human reading their own DevTools while pairing.)

**The rule that follows:** *anything you want an agent to see must reach the main thread.* Design
for it. Two mechanisms, both worth having, cover it:

1. **Forward the worker's logs to main.**
2. **Expose a state snapshot + a log ring buffer on a global handle.**

---

## Principle 1 — Forward every worker log line to the main thread

Give the worker a logger whose emit path does two things: write to the worker's own console *and*
`postMessage` the line to the main thread. On main, a handler re-`console.*`s each forwarded line
(now MCP-readable) **and** pushes it into a bounded ring buffer.

```
worker realm                                main thread
────────────                                ───────────
logger.notice("ws","open")
  ├─ console.info("[ns:worker] ws", …)      (invisible to MCP)
  └─ postMessage({__obs, kind:"log", line}) ──▶ onmessage → ingest(line)
                                                   ├─ ring.push(line)          → window.__ns.logs
                                                   └─ console.info("[ns:worker] ws", …)  (MCP reads THIS)
```

Design notes that matter in practice:

- **Tag every line** (`[ns:worker]`, `[ns:view]`, `[ns:decode]`) and carry a **category**
  (`ws` / `frame` / `hb`) so the console + ring buffer are greppable by subsystem.
- **A stable discriminant** on the message (`__workerObs: true` + a `channel` string) lets the
  host demultiplex observability traffic from its own worker messages with one guard, and lets two
  independent bridges on one page coexist without cross-talk.
- **Be robust to un-cloneable args.** A log arg might be a function, a DOM node, a `VideoFrame` —
  `postMessage` throws `DataCloneError` on those. Post the args as-is, and on a throw retry with a
  stringified copy, so a rich log arg never wedges the bridge.
- **Gate the forwarding by tier**, mirroring local console emission: errors always, lifecycle
  notices by default, the verbose per-frame firehose only when debug is on. Forwarding then costs
  nothing in the normal (quiet) case.
- **A bounded ring buffer** (last N lines) means the log history is readable *without a live
  console attached* — an agent can `JSON.stringify(window.__ns.logs)` at any moment, including
  after the interesting event has scrolled past.

## Principle 2 — A discoverable `window.__<ns>` registry + state snapshots

Even with zero logs, an agent (or a human) should be able to interrogate a live instance from the
console. Install a small registry at `window.__<ns>` where each instance **registers on
construct** and **deregisters on dispose**:

- `window.__ns.logs` — the merged ring buffer.
- `window.__ns.state()` / `.stats()` / `.surface()` / `.capture()` — **pluggable snapshot
  providers** the host supplies (live getters, not frozen values), so the current state is one
  call away.
- `window.__ns.instances` — every live instance (a page may host several); `.view` is the
  sole/first one for the common single-widget case.

Two refinements that avoid sharp edges:

- **The registry object persists even when empty.** Embedding hosts (marimo, an SPA route swap)
  dispose and recreate a widget across a rebuild; a *stable* `window.__ns` handle survives that
  churn, and `.logs` history outlives a single connection. Instances come and go; the handle
  stays.
- **One discoverability line, once.** On first construct, emit a single `notice` naming the
  handle: `[ns] worker observability at window.__ns — .setDebug(true), .logs, .state(), …`. One
  line, not spam, and it tells a human/agent exactly what to type. (Keep it out of any
  `[ns:` greppable prefix so log filters don't trip over it.)

## Principle 3 — Runtime debug toggle, not compile-time

If verbosity is fixed at construction, debugging a *running* page means a rebuild + reload (or, in
a notebook, a kernel restart) just to turn logs on — far too slow for a pairing loop. Make it
flippable **at runtime**:

- `window.__ns.setDebug(true)` posts `{__obs, kind:"set_debug", debug:true}` to each instance's
  worker, which **rebuilds its logger** in place, and simultaneously rebuilds the **main-thread**
  loggers the registry minted. No rebuild, no reload.
- The trick that makes "rebuild in place" work is a **mutable logger facade**: callers hold one
  stable logger reference forever; `setDebug` swaps the backing logger underneath them. A logger
  handed to a sub-component (a decode pipeline) flips too, because it holds the same facade.
- **Optional convenience:** honor `?debug=1` / `?<ns>Debug=1` in the URL and a
  `localStorage.<ns>Debug` flag, read once at construct, so a plain reload can start verbose
  without touching code. (Read these on the main thread only — a worker realm has no
  `localStorage`.)

## Principle 4 — A cadence heartbeat, not per-frame spam

Per-frame logging is a firehose that is useless at 30–60 fps and drowns the console. The useful
middle ground is a **periodic one-line summary** emitted from the worker (and forwarded to main):

```
[ns:worker] hb fps 10.0 displayed 146 dropped 0 queue 0 · webcodecs/2d · rtt 1.6ms seq 145
```

Rules that keep it clean: one line per interval (~5 s); **only when something is flowing** (skip,
or go quiet, when idle); include the fields that actually localize bugs (transport, surface,
displayed/dropped deltas, queue depth, recoveries, RTT). Emit it on the **verbose (debug) tier**
so it appears exactly when someone has flipped debug on to watch health — additive to the
always-on error/notice tiers, never competing with them.

---

## Screenshot vs. readback — name the distinction

A corollary worth writing down, because the two disagree and that disagreement *is* the diagnosis.
When a "blank / black" symptom appears, check **both** a pixel **readback** of the drawing surface
*and* a **screenshot** of the composited element:

| readback | screenshot | conclusion |
| --- | --- | --- |
| picture | black | **compositing / DOM / host** problem (pixels exist, never composited) |
| black | black | **decode / draw** problem (upstream of present) |
| picture | picture, user says black | wrong element / a cached view |

Expose a `capture()` snapshot provider that reads the *on-screen* surface where possible, so an
agent can compare `window.__ns.capture()` against a `screenshot` rather than trusting either
alone.

---

## How the library packages this for drop-in reuse

`@habemus-papadum/worker-observability` splits along the realm boundary so each side typechecks
under its own lib (DOM vs WebWorker) and imports only what is safe there:

| import | use | contents |
| --- | --- | --- |
| `.../worker` | inside the Worker | `installWorkerObservability({channel, tag, debug, post})` → a stable `logger`, a `handleMessage` that consumes `set_debug`, and `startHeartbeat(summary)`. |
| `.../main` | on the main thread | `registerObservable({channel, snapshots, postToWorker})` → an `ObsInstance` (`ingest`, `makeLogger`, `setDebug`, `dispose`) that installs `window.__<ns>`; plus `readDebugFlag()`. |
| `.` (root) | either realm | pure core: `RingBuffer`, `buildLogger`/`MutableLogger`, the message types + `isWorkerObsMessage`/`isMainObsMessage` guards. |

Everything is injectable (the `post` function, the console, the clock, the timer, the registry
target object), so the whole thing is unit-testable in Node with no DOM — the ring buffer, the
registry, and the worker↔main round-trip each have tests.

Wiring it into an app is four small seams:

1. **Worker:** `const obs = installWorkerObservability({channel, tag, debug, post: m => self.postMessage(m)})`;
   use `obs.logger` everywhere; at the top of `onmessage`, `if (obs.handleMessage(data)) return`;
   `obs.startHeartbeat(summary)`.
2. **Main:** `const obs = registerObservable({channel, snapshots, postToWorker: m => worker.postMessage(m)})`;
   in `worker.onmessage`, `if (obs.ingest(data)) return` before your own handling; mint the
   main-thread logger via `obs.makeLogger(tag)`; `obs.dispose()` on teardown.
3. **Debug flag:** seed it from `options.debug ?? readDebugFlag(ns)` and pass `obs.debug` into the
   worker's init so URL/localStorage propagate.
4. **Nothing else** — every embedding (a plain page, a framework wrapper, a notebook widget) that
   mounts the view gets `window.__<ns>` for free.

The result: **off by default** (zero console spam in normal use), **flippable from the console**
without a rebuild, and the worker's internals are finally readable by the exact tools an agent
uses to debug them.

See also: [`agentic_frontend_debugging.md`](agentic_frontend_debugging.md) (the pairing workflow
and the instrument-at-the-seams rules this builds on) and the
[frontend-debugging skill](../.claude/skills/frontend-debugging/SKILL.md).
