<script lang="ts">
  import { type Snippet, untrack } from "svelte";
  import type { SurfacePreference } from "@habemus-papadum/rfb-widgets";
  import {
    formatBadge,
    formatStatsRows,
    recordGlyph,
    recordingFilename,
    recordTitle,
    statusLabel,
    SURFACE_CHOICES,
  } from "@habemus-papadum/rfb-ui";
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
  let recording = $state(false);
  let rootEl = $state<HTMLDivElement>();

  // Batteries default: enable crop/zoom/pan gestures (the toolbar has zoom controls too).
  const gestures = untrack(() => options.gestures ?? true);
  const fb = createRemoteFramebuffer(untrack(() => ({ ...options, imageOnly, gestures })));
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
  function setSurface(kind: SurfacePreference): void {
    fb.view()?.setSurface(kind);
  }
  const zoomIn = () => fb.view()?.zoomBy(1.25);
  const zoomOut = () => fb.view()?.zoomBy(1 / 1.25);
  const resetView = () => fb.view()?.resetView();

  // Recording is a main-thread-canvas feature; this batteries path uses the OffscreenCanvas
  // view (Mode A), so canRecord is false and the toggle disables. Re-evaluated on state change
  // (the view exists by then). See docs/guide_javascript.md (Recording).
  const canRecord = $derived.by(() => {
    void $connState;
    return !!fb.view()?.canRecord;
  });
  async function toggleRecording(): Promise<void> {
    const v = fb.view();
    if (!v || !v.canRecord) return;
    if (v.isRecording) {
      const blob = await v.stopRecording();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = recordingFilename(blob.type);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      recording = false;
    } else {
      v.startRecording();
      recording = true;
    }
  }
</script>

<div bind:this={rootEl} class={`rfb-root ${className}`} data-state={$connState}>
  <div class="rfb-viewport" use:rfbAction={{ ...options, imageOnly, gestures }}></div>

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
      <button
        type="button"
        class="rfb-button"
        data-active={recording}
        disabled={!canRecord}
        title={recordTitle(canRecord, recording)}
        onclick={toggleRecording}
      >{recordGlyph(recording)}</button>
      <button type="button" class="rfb-button" title="Fullscreen" onclick={fullscreen}>⛶</button>
      <div class="rfb-toolbar-sep"></div>
      <select
        class="rfb-select"
        title="Display backend (rebuilds + reconnects)"
        value={$connStats.surface ?? "2d"}
        onchange={(e) => setSurface(e.currentTarget.value as SurfacePreference)}
      >
        {#each SURFACE_CHOICES as c (c.value)}
          <option value={c.value} title={c.title}>{c.label}</option>
        {/each}
      </select>
      <button type="button" class="rfb-button" title="Zoom out" onclick={zoomOut}>−</button>
      <button type="button" class="rfb-button" title="Zoom in" onclick={zoomIn}>+</button>
      <button type="button" class="rfb-button" title="Fit / reset view" onclick={resetView}>⤢</button>
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
