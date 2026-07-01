<script lang="ts">
  import { type Snippet, untrack } from "svelte";
  import { formatBadge, formatStatsRows, statusLabel } from "@habemus-papadum/rfb-ui";
  import { createRemoteFramebuffer, type RfbSvelteOptions } from "./createRemoteFramebuffer";

  type Props = RfbSvelteOptions & {
    class?: string;
    toolbar?: boolean;
    hud?: boolean;
    status?: boolean;
    badge?: boolean;
    children?: Snippet;
  };

  let {
    class: className = "",
    toolbar = true,
    hud = false,
    status = true,
    badge = true,
    children,
    ...options
  }: Props = $props();

  // These read props/state for their INITIAL value only (reactivity flows through the
  // action's params below), so untrack to make that intent explicit.
  let imageOnly = $state(untrack(() => !!options.imageOnly));
  let hudOpen = $state(untrack(() => hud));
  let rootEl = $state<HTMLDivElement>();

  const fb = createRemoteFramebuffer(untrack(() => ({ ...options, imageOnly })));
  const rfbAction = fb.action;
  // Renamed to avoid colliding with the `$state` rune.
  const { state: connState, stats: connStats, error: connError } = fb;

  function screenshot(): void {
    fb.capture("blob").then((b) => {
      const url = URL.createObjectURL(b as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "framebuffer.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  function fullscreen(): void {
    rootEl?.requestFullscreen?.();
  }
</script>

<div bind:this={rootEl} class={`rfb-root ${className}`} data-state={$connState}>
  <div class="rfb-viewport" use:rfbAction={{ ...options, imageOnly }}></div>

  {#if status}
    <div class="rfb-status">{statusLabel($connState)}</div>
  {/if}

  {#if badge && $connStats.transport !== "none"}
    <div class="rfb-badge">{formatBadge($connStats)}</div>
  {/if}

  {#if toolbar}
    <div class="rfb-toolbar" data-pinned={hudOpen}>
      <button type="button" class="rfb-button" data-active={hudOpen} title="Toggle stats" onclick={() => (hudOpen = !hudOpen)}>📊</button>
      <button type="button" class="rfb-button" data-active={imageOnly} title="Toggle transport" onclick={() => (imageOnly = !imageOnly)}>⇄</button>
      <button type="button" class="rfb-button" title="Screenshot" onclick={screenshot}>📷</button>
      <button type="button" class="rfb-button" title="Fullscreen" onclick={fullscreen}>⛶</button>
    </div>
  {/if}

  {#if hudOpen}
    <pre class="rfb-hud">{formatStatsRows($connState, $connStats)
        .map(([k, v]) => `${k.padEnd(15)}${v}`)
        .join("\n")}</pre>
  {/if}

  {#if $connError}
    <div class="rfb-banner" role="alert">
      <span>{$connError.message}</span>
      <button type="button" class="rfb-button" title="Reconnect" onclick={fb.reconnect}>↻</button>
    </div>
  {/if}

  {#if $connState !== "negotiated" && $connStats.framesDisplayed === 0}
    <div class="rfb-loading"><div class="rfb-spinner"></div></div>
  {/if}

  {@render children?.()}
</div>
