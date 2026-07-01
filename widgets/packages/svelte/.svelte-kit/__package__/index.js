// @habemus-papadum/rfb-svelte — Svelte bindings for the pdum.rfb remote framebuffer client.
// Tier 1 (headless): createRemoteFramebuffer (use: action + stores).
// Tier 2 (batteries): <RemoteFramebuffer /> (import "@habemus-papadum/rfb-svelte/styles.css").
export { createRemoteFramebuffer } from "./createRemoteFramebuffer";
export { default as RemoteFramebuffer } from "./RemoteFramebuffer.svelte";
