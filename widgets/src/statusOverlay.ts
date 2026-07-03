// A small, dependency-free status overlay drawn OVER the canvas by the core view. It makes the
// otherwise-mysterious blank moments legible: connecting, reconnecting, disconnected, and the
// wait for the first frame. Purely informational — `pointer-events: none`, so it never eats
// canvas input. (A display resize repaints in place, so it needs no overlay.)
//
// Pluggable: `RfbViewOptions.statusOverlay` can be `false` (off) or a render function that
// returns custom DOM per status. The default renders a spinner + label; theme it via the
// `--rfb-status-*` CSS variables or by restyling the `.rfb-status*` classes.

import type { ConnectionState } from "./types";

/** Coarse view status the overlay renders. `live` = frames are flowing → overlay hidden. */
export type StatusKind = "connecting" | "reconnecting" | "disconnected" | "live";

export interface ViewStatus {
  kind: StatusKind;
  /** The raw connection state behind this status (for custom renderers). */
  state: ConnectionState;
  /** Human label for the default renderer (empty for `live`). */
  label: string;
  /** Whether a spinner should show (busy states, not `disconnected`/`live`). */
  busy: boolean;
}

/** Custom overlay content per status. Return a Node to show it, or `null` to hide the overlay. */
export type StatusRenderer = (status: ViewStatus) => Node | null;

const LABELS: Record<StatusKind, string> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  live: "",
};

/** Derive the overlay status from the connection state and whether any frame has displayed yet. */
export function computeStatus(state: ConnectionState, framesDisplayed: number): ViewStatus {
  let kind: StatusKind;
  if (state === "closed" || state === "error") kind = "disconnected";
  else if (state === "reconnecting") kind = "reconnecting";
  else if (state === "connecting") kind = "connecting";
  else if (framesDisplayed === 0) kind = "connecting"; // socket up, still awaiting the first frame
  else kind = "live";
  return { kind, state, label: LABELS[kind], busy: kind !== "disconnected" && kind !== "live" };
}

const STYLE_ID = "rfb-status-overlay-styles";
const CSS = `
.rfb-status {
  position: absolute; inset: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  color: var(--rfb-status-fg, #f3efe6);
  font: 500 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--rfb-status-scrim, rgba(0, 0, 0, 0.35));
  transition: opacity 0.15s ease;
}
.rfb-status[data-kind="live"] { display: none; }
.rfb-status[data-kind="disconnected"] { background: var(--rfb-status-scrim-error, rgba(45, 12, 8, 0.5)); }
.rfb-status__box {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.7rem; border-radius: 6px;
  background: var(--rfb-status-bg, rgba(0, 0, 0, 0.55));
}
.rfb-status__spinner {
  width: 14px; height: 14px; box-sizing: border-box;
  border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%;
  animation: rfb-status-spin 0.7s linear infinite;
  opacity: 0.9;
}
@keyframes rfb-status-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rfb-status__spinner { animation-duration: 1.6s; } }
`;

/** Inject the overlay stylesheet once per document (keyframes can't be inlined on elements). */
function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** Default renderer: a scrim with a centered spinner + label. */
function defaultRender(status: ViewStatus): Node {
  const doc = document;
  const box = doc.createElement("div");
  box.className = "rfb-status__box";
  if (status.busy) {
    const spinner = doc.createElement("span");
    spinner.className = "rfb-status__spinner";
    box.appendChild(spinner);
  }
  const label = doc.createElement("span");
  label.className = "rfb-status__label";
  label.textContent = status.label;
  box.appendChild(label);
  return box;
}

export interface StatusOverlayHandle {
  update(status: ViewStatus): void;
  destroy(): void;
}

/** Mount an overlay into `host` (which must be a positioned/relative offset parent). Returns a
 *  handle whose `update()` re-renders on status change and `destroy()` removes it. */
export function createStatusOverlay(host: HTMLElement, render: StatusRenderer = defaultRender): StatusOverlayHandle {
  ensureStyles(host.ownerDocument);
  const root = host.ownerDocument.createElement("div");
  root.className = "rfb-status";
  root.setAttribute("aria-live", "polite");
  root.dataset.kind = "connecting";
  host.appendChild(root);

  let lastKind: StatusKind | null = null;
  return {
    update(status: ViewStatus): void {
      if (status.kind === lastKind) return; // only touch the DOM on an actual transition
      lastKind = status.kind;
      root.dataset.kind = status.kind;
      const content = render(status);
      root.replaceChildren(...(content ? [content] : []));
      root.style.display = content && status.kind !== "live" ? "" : "none";
    },
    destroy(): void {
      root.remove();
    },
  };
}
