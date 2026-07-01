// @habemus-papadum/rfb-solid — SolidJS bindings for the pdum.rfb remote framebuffer client.
// Tier 1 (headless): createRemoteFramebuffer (ref + signals).
// Tier 2 (batteries): <RemoteFramebuffer /> (import "@habemus-papadum/rfb-solid/styles.css").

export { createRemoteFramebuffer } from "./createRemoteFramebuffer";
export type { RfbSolidOptions, RemoteFramebufferHandle } from "./createRemoteFramebuffer";

export { RemoteFramebuffer } from "./RemoteFramebuffer";
export type { RemoteFramebufferProps, ChromeContext } from "./RemoteFramebuffer";

export type { ConnectionState, Stats } from "@habemus-papadum/rfb-widgets";
