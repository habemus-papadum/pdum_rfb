import { type CSSProperties, type ReactNode, useCallback, useRef, useState } from "react";
import type { ConnectionState, Stats } from "@habemus-papadum/rfb-widgets";
import { formatBadge, formatStatsRows, statusLabel } from "@habemus-papadum/rfb-ui";
import { type UseRfbOptions, useRemoteFramebuffer, useRemoteFramebufferStats } from "./useRemoteFramebuffer";

/** Values handed to every render-prop so custom chrome can drive the view. */
export interface ChromeContext {
  state: ConnectionState;
  stats: Stats;
  error: Error | null;
  capture: (format?: "imagedata" | "blob") => Promise<ImageData | Blob>;
  screenshot: () => void;
  reconnect: () => void;
  toggleHud: () => void;
  hudOpen: boolean;
  fullscreen: () => void;
  imageOnly: boolean;
  setImageOnly: (v: boolean) => void;
}

export interface RemoteFramebufferProps extends UseRfbOptions {
  className?: string;
  style?: CSSProperties;
  /** Show the toolbar (screenshot / fullscreen / transport / HUD toggle). Default `true`. */
  toolbar?: boolean;
  /** Start with the stats HUD open. Default `false` (toggle via the toolbar). */
  hud?: boolean;
  /** Show the connection status pill. Default `true`. */
  status?: boolean;
  /** Show the compact latency/quality badge. Default `true`. */
  badge?: boolean;
  /** Replace a region entirely; each receives the {@link ChromeContext}. */
  renderStatus?: (ctx: ChromeContext) => ReactNode;
  renderToolbar?: (ctx: ChromeContext) => ReactNode;
  renderHud?: (ctx: ChromeContext) => ReactNode;
  renderError?: (ctx: ChromeContext) => ReactNode;
  /** Free overlay layer rendered above the canvas. */
  children?: ReactNode;
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
 * Batteries-included React component: a themeable framebuffer viewport with a status pill,
 * latency badge, a toggleable stats HUD, an error banner, and a toolbar. Import the opt-in
 * stylesheet once: `import "@habemus-papadum/rfb-react/styles.css"`. Theme via the CSS
 * custom properties on `.rfb-root`, or replace regions with the `render*` props / `children`.
 */
export function RemoteFramebuffer(props: RemoteFramebufferProps): ReactNode {
  const {
    className,
    style,
    toolbar = true,
    hud = false,
    status = true,
    badge = true,
    renderStatus,
    renderToolbar,
    renderHud,
    renderError,
    children,
    ...rfbOptions
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const [imageOnly, setImageOnly] = useState<boolean>(!!rfbOptions.imageOnly);
  const [hudOpen, setHudOpen] = useState<boolean>(hud);

  const { containerRef, state, error, capture, reconnect, view } = useRemoteFramebuffer({
    ...rfbOptions,
    imageOnly,
  });
  const stats = useRemoteFramebufferStats(view);

  const screenshot = useCallback(async () => {
    const blob = (await capture("blob")) as Blob;
    downloadBlob(blob, "framebuffer.png");
  }, [capture]);
  const fullscreen = useCallback(() => void rootRef.current?.requestFullscreen?.(), []);
  const toggleHud = useCallback(() => setHudOpen((v) => !v), []);

  const ctx: ChromeContext = {
    state,
    stats,
    error,
    capture,
    screenshot,
    reconnect,
    toggleHud,
    hudOpen,
    fullscreen,
    imageOnly,
    setImageOnly,
  };

  const rootClass = className ? `rfb-root ${className}` : "rfb-root";

  return (
    <div ref={rootRef} className={rootClass} data-state={state} style={style}>
      <div ref={containerRef} className="rfb-viewport" />

      {status && (renderStatus ? renderStatus(ctx) : <div className="rfb-status">{statusLabel(state)}</div>)}

      {badge && stats.transport !== "none" && <div className="rfb-badge">{formatBadge(stats)}</div>}

      {toolbar &&
        (renderToolbar ? (
          renderToolbar(ctx)
        ) : (
          <div className="rfb-toolbar" data-pinned={hudOpen ? "true" : "false"}>
            <button
              type="button"
              className="rfb-button"
              data-active={hudOpen ? "true" : "false"}
              title="Toggle stats"
              onClick={toggleHud}
            >
              📊
            </button>
            <button
              type="button"
              className="rfb-button"
              data-active={imageOnly ? "true" : "false"}
              title={imageOnly ? "Transport: image (click for H.264)" : "Transport: H.264 (click for image)"}
              onClick={() => setImageOnly((v) => !v)}
            >
              ⇄
            </button>
            <button type="button" className="rfb-button" title="Screenshot" onClick={screenshot}>
              📷
            </button>
            <button type="button" className="rfb-button" title="Fullscreen" onClick={fullscreen}>
              ⛶
            </button>
          </div>
        ))}

      {hudOpen &&
        (renderHud ? (
          renderHud(ctx)
        ) : (
          <pre className="rfb-hud">
            {formatStatsRows(state, stats)
              .map(([k, v]) => `${k.padEnd(15)}${v}`)
              .join("\n")}
          </pre>
        ))}

      {error &&
        (renderError ? (
          renderError(ctx)
        ) : (
          <div className="rfb-banner" role="alert">
            <span>{error.message}</span>
            <button type="button" className="rfb-button" title="Reconnect" onClick={reconnect}>
              ↻
            </button>
          </div>
        ))}

      {state !== "negotiated" && stats.framesDisplayed === 0 && (
        <div className="rfb-loading">
          <div className="rfb-spinner" />
        </div>
      )}

      {children}
    </div>
  );
}
