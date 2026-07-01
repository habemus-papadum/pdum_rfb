import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@habemus-papadum/rfb-widgets";
import { RemoteFramebuffer } from "../src/index";

// The wrapper's job is lifecycle + reactivity, not decoding — happy-dom has no
// OffscreenCanvas/Worker, so we mock the core view and record construct/dispose + expose
// the callbacks the wrapper installed.
vi.mock("@habemus-papadum/rfb-widgets", () => {
  const instances: FakeView[] = [];
  class FakeView {
    disposed = false;
    capture = vi.fn(async () => new Blob());
    dispose = vi.fn(() => {
      this.disposed = true;
    });
    constructor(
      public el: HTMLElement,
      public opts: any,
    ) {
      instances.push(this);
    }
  }
  return { RemoteFramebufferView: FakeView, __instances: instances };
});

const views = () => (core as unknown as { __instances: any[] }).__instances;

afterEach(() => {
  cleanup();
  views().length = 0;
});

describe("<RemoteFramebuffer> (React)", () => {
  it("constructs exactly one view with the url, into the viewport element", () => {
    render(<RemoteFramebuffer url="ws://host/one" />);
    expect(views()).toHaveLength(1);
    expect(views()[0].opts.url).toBe("ws://host/one");
    expect(views()[0].el.className).toContain("rfb-viewport");
  });

  it("disposes exactly once on unmount", () => {
    const { unmount } = render(<RemoteFramebuffer url="ws://host/one" />);
    const view = views()[0];
    unmount();
    expect(view.dispose).toHaveBeenCalledTimes(1);
  });

  it("reflects connection state via data-state", () => {
    const { container } = render(<RemoteFramebuffer url="ws://host/one" />);
    const root = container.querySelector(".rfb-root")!;
    expect(root.getAttribute("data-state")).toBe("connecting");
    act(() => views()[0].opts.onState("negotiated"));
    expect(root.getAttribute("data-state")).toBe("negotiated");
  });

  it("recreates the view when url changes (dispose old, construct new)", () => {
    const { rerender } = render(<RemoteFramebuffer url="ws://host/one" />);
    expect(views()).toHaveLength(1);
    rerender(<RemoteFramebuffer url="ws://host/two" />);
    expect(views()).toHaveLength(2);
    expect(views()[0].dispose).toHaveBeenCalledTimes(1);
    expect(views()[1].opts.url).toBe("ws://host/two");
  });

  it("feeds per-frame stats into the HUD without recreating the view", () => {
    const { container } = render(<RemoteFramebuffer url="ws://host/one" hud />);
    act(() =>
      views()[0].opts.onStats({
        framesDisplayed: 5,
        framesDropped: 1,
        lastDisplayedSeq: 5,
        decodeQueueSize: 2,
        transport: "image",
      }),
    );
    expect(views()).toHaveLength(1); // no recreate
    expect(container.querySelector(".rfb-hud")!.textContent).toContain("image");
  });
});
