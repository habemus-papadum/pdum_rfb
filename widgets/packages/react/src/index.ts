// @habemus-papadum/rfb-react — React bindings for the pdum.rfb remote framebuffer client.
// Tier 1 (headless): useRemoteFramebuffer + useRemoteFramebufferStats.
// Tier 2 (batteries): <RemoteFramebuffer /> (import "@habemus-papadum/rfb-react/styles.css").

export { useRemoteFramebuffer, useRemoteFramebufferStats } from "./useRemoteFramebuffer";
export type { UseRfbOptions, UseRfbResult } from "./useRemoteFramebuffer";

export { RemoteFramebuffer } from "./RemoteFramebuffer";
export type { RemoteFramebufferProps, ChromeContext } from "./RemoteFramebuffer";

export type { ConnectionState, Stats } from "@habemus-papadum/rfb-widgets";
