import { type Accessor, type JSX, Show, createSignal, mergeProps, splitProps } from "solid-js";
import type { ConnectionState, Stats } from "@habemus-papadum/rfb-widgets";
import { formatBadge, formatStatsRows, statusLabel } from "@habemus-papadum/rfb-ui";
import { type RfbSolidOptions, createRemoteFramebuffer } from "./createRemoteFramebuffer";

/** Reactive context handed to every render-prop so custom chrome can drive the view. */
export interface ChromeContext {
  state: Accessor<ConnectionState>;
  stats: Accessor<Stats>;
  error: Accessor<Error | null>;
  hudOpen: Accessor<boolean>;
  imageOnly: Accessor<boolean>;
  capture: (format?: "imagedata" | "blob") => Promise<ImageData | Blob>;
  screenshot: () => void;
  reconnect: () => void;
  toggleHud: () => void;
  fullscreen: () => void;
  setImageOnly: (v: boolean) => void;
}

export interface RemoteFramebufferProps extends RfbSolidOptions {
  class?: string;
  style?: JSX.CSSProperties | string;
  toolbar?: boolean;
  hud?: boolean;
  status?: boolean;
  badge?: boolean;
  children?: JSX.Element;
  renderStatus?: (ctx: ChromeContext) => JSX.Element;
  renderToolbar?: (ctx: ChromeContext) => JSX.Element;
  renderHud?: (ctx: ChromeContext) => JSX.Element;
  renderError?: (ctx: ChromeContext) => JSX.Element;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Batteries-included Solid component: a themeable viewport with a status pill, latency
 * badge, a toggleable stats HUD, an error banner, and a toolbar. Import the opt-in
 * stylesheet once: `import "@habemus-papadum/rfb-solid/styles.css"`. Theme via the CSS
 * custom properties on `.rfb-root`, or replace regions with the `render*` props / children.
 */
export function RemoteFramebuffer(props: RemoteFramebufferProps): JSX.Element {
  const merged = mergeProps({ toolbar: true, hud: false, status: true, badge: true }, props);
  const [local, options] = splitProps(merged, [
    "class",
    "style",
    "toolbar",
    "hud",
    "status",
    "badge",
    "children",
    "renderStatus",
    "renderToolbar",
    "renderHud",
    "renderError",
  ]);

  const [imageOnly, setImageOnly] = createSignal<boolean>(!!props.imageOnly);
  const [hudOpen, setHudOpen] = createSignal<boolean>(!!local.hud);
  let rootEl!: HTMLDivElement;

  const fb = createRemoteFramebuffer(() => ({ ...options, imageOnly: imageOnly() }));
  const { state, stats, error, capture, reconnect } = fb;

  const toggleHud = () => setHudOpen((v) => !v);
  const fullscreen = () => void rootEl?.requestFullscreen?.();
  const screenshot = async () => downloadBlob((await capture("blob")) as Blob, "framebuffer.png");

  const ctx: ChromeContext = {
    state,
    stats,
    error,
    hudOpen,
    imageOnly,
    capture,
    screenshot,
    reconnect,
    toggleHud,
    fullscreen,
    setImageOnly,
  };

  return (
    <div ref={rootEl} class={`rfb-root ${local.class ?? ""}`} data-state={state()} style={local.style}>
      <div class="rfb-viewport" ref={fb.ref} />

      <Show when={local.status}>
        {local.renderStatus ? local.renderStatus(ctx) : <div class="rfb-status">{statusLabel(state())}</div>}
      </Show>

      <Show when={local.badge && stats().transport !== "none"}>
        <div class="rfb-badge">{formatBadge(stats())}</div>
      </Show>

      <Show when={local.toolbar}>
        {local.renderToolbar ? (
          local.renderToolbar(ctx)
        ) : (
          <div class="rfb-toolbar" data-pinned={hudOpen()}>
            <button type="button" class="rfb-button" data-active={hudOpen()} title="Toggle stats" onClick={toggleHud}>
              📊
            </button>
            <button
              type="button"
              class="rfb-button"
              data-active={imageOnly()}
              title="Toggle transport"
              onClick={() => setImageOnly((v) => !v)}
            >
              ⇄
            </button>
            <button type="button" class="rfb-button" title="Screenshot" onClick={screenshot}>
              📷
            </button>
            <button type="button" class="rfb-button" title="Fullscreen" onClick={fullscreen}>
              ⛶
            </button>
          </div>
        )}
      </Show>

      <Show when={hudOpen()}>
        {local.renderHud ? (
          local.renderHud(ctx)
        ) : (
          <pre class="rfb-hud">
            {formatStatsRows(state(), stats())
              .map(([k, v]) => `${k.padEnd(15)}${v}`)
              .join("\n")}
          </pre>
        )}
      </Show>

      <Show when={error()}>
        {local.renderError ? (
          local.renderError(ctx)
        ) : (
          <div class="rfb-banner" role="alert">
            <span>{error()!.message}</span>
            <button type="button" class="rfb-button" title="Reconnect" onClick={reconnect}>
              ↻
            </button>
          </div>
        )}
      </Show>

      <Show when={state() !== "negotiated" && stats().framesDisplayed === 0}>
        <div class="rfb-loading">
          <div class="rfb-spinner" />
        </div>
      </Show>

      {local.children}
    </div>
  );
}
