// The "Solid" framework path: mount the core RemoteFramebufferView inside a SolidJS
// reactive root via `solid-js/web` `render` (exactly what the @habemus-papadum/rfb-solid
// headless primitive does internally). No JSX — `render` inserts a plain host <div> and we
// attach the view once it's live in the DOM — so the demo build needs no Solid compiler
// plugin, only the pre-compiled solid-js runtime.
import { render } from "solid-js/web";
import { RemoteFramebufferView, type RfbViewOptions } from "@habemus-papadum/rfb-widgets";

export interface SolidViewerHandle {
  view: () => RemoteFramebufferView;
  dispose: () => void;
}

export function mountSolid(container: HTMLElement, options: RfbViewOptions): SolidViewerHandle {
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  // Solid inserts the returned node into `container` synchronously, so `host` is live in the
  // DOM by the time `render` returns and the view can measure it. `render`'s code fn is typed
  // `() => JSX.Element`; a raw DOM node is valid at runtime (Solid inserts Nodes), so cast past
  // the JSX type (which isn't in scope in a plain `.ts` file).
  const disposeRoot = render(() => host as never, container);
  const view = new RemoteFramebufferView(host, options);
  return {
    view: () => view,
    dispose: () => {
      view.dispose();
      disposeRoot();
    },
  };
}
