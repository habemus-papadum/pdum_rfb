<script lang="ts">
  // The "Svelte" framework path: a minimal Svelte 5 component that mounts the core
  // RemoteFramebufferView into its own <div> (exactly what the @habemus-papadum/rfb-svelte
  // headless primitive does internally). Kept local so the demo needs no wrapper-package
  // build — the Vite svelte plugin compiles just this file.
  import { onDestroy, onMount } from "svelte";
  import { RemoteFramebufferView, type RfbViewOptions } from "@habemus-papadum/rfb-widgets";

  let { options, onReady }: { options: RfbViewOptions; onReady: (v: RemoteFramebufferView) => void } = $props();

  let host: HTMLDivElement;
  let view: RemoteFramebufferView | undefined;

  onMount(() => {
    view = new RemoteFramebufferView(host, options);
    onReady(view);
  });
  onDestroy(() => view?.dispose());
</script>

<div bind:this={host} style="width: 100%; height: 100%"></div>
