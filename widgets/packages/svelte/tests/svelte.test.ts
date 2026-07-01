import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteFramebuffer } from "../src/createRemoteFramebuffer";

// The tier-1 factory owns lifecycle + reactivity; mock the core (happy-dom has no
// OffscreenCanvas/Worker). The .svelte component is thin glue over this factory.
vi.mock("@habemus-papadum/rfb-widgets", () => {
  const instances: FakeView[] = [];
  class FakeView {
    capture = vi.fn(async () => new Blob());
    dispose = vi.fn();
    constructor(
      public el: HTMLElement,
      public opts: any,
    ) {
      instances.push(this);
    }
  }
  return { RemoteFramebufferView: FakeView, __instances: instances };
});

import * as core from "@habemus-papadum/rfb-widgets";
const views = () => (core as unknown as { __instances: any[] }).__instances;

afterEach(() => {
  views().length = 0;
});

describe("createRemoteFramebuffer (Svelte)", () => {
  it("action builds one view and the stores react to callbacks", () => {
    const fb = createRemoteFramebuffer({ url: "ws://host/one" });
    const handle = fb.action(document.createElement("div"), { url: "ws://host/one" });
    expect(views()).toHaveLength(1);
    expect(views()[0].opts.url).toBe("ws://host/one");
    expect(get(fb.state)).toBe("connecting");

    views()[0].opts.onState("negotiated");
    expect(get(fb.state)).toBe("negotiated");

    handle?.destroy?.();
    expect(views()[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("rebuilds on a connect-critical update, but not on an unchanged one", () => {
    const fb = createRemoteFramebuffer({ url: "ws://host/one" });
    const handle = fb.action(document.createElement("div"), { url: "ws://host/one" });

    handle?.update?.({ url: "ws://host/one" });
    expect(views()).toHaveLength(1); // same connect key -> no rebuild

    handle?.update?.({ url: "ws://host/two" });
    expect(views()).toHaveLength(2); // changed -> rebuild
    expect(views()[0].dispose).toHaveBeenCalledTimes(1);
    expect(views()[1].opts.url).toBe("ws://host/two");
  });
});
