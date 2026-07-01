// The framework-toggle seam. `mountViewer` mounts the framebuffer viewer under the chosen
// framework and returns a uniform handle (setFit / capture / dispose). v1 ships Vanilla
// (the core RemoteFramebufferView) and React (the core view inside a React component); the
// seam is deliberately small so Svelte/Solid drop in the same way.

import { RemoteFramebufferView, type RfbViewOptions } from "@habemus-papadum/rfb-widgets";
import type { FitMode } from "@habemus-papadum/rfb-widgets";

export type Framework = "vanilla" | "react";

export const FRAMEWORKS: { id: Framework; label: string }[] = [
  { id: "vanilla", label: "Vanilla" },
  { id: "react", label: "React" },
];

export interface ViewerHandle {
  framework: Framework;
  setFit(fit: FitMode, background?: string): void;
  capture(): Promise<Blob>;
  dispose(): void;
}

export async function mountViewer(
  framework: Framework,
  container: HTMLElement,
  options: RfbViewOptions,
): Promise<ViewerHandle> {
  if (framework === "react") {
    const [{ createRoot }, { createElement }, { ReactViewer }] = await Promise.all([
      import("react-dom/client"),
      import("react"),
      import("./reactViewer"),
    ]);
    let view: RemoteFramebufferView | null = null;
    const root = createRoot(container);
    root.render(createElement(ReactViewer, { options, onReady: (v) => (view = v) }));
    return {
      framework,
      setFit: (fit, bg) => view?.setFit(fit, bg),
      capture: async () => (await view!.capture("blob")) as Blob,
      dispose: () => root.unmount(),
    };
  }
  const view = new RemoteFramebufferView(container, options);
  return {
    framework,
    setFit: (fit, bg) => view.setFit(fit, bg),
    capture: async () => (await view.capture("blob")) as Blob,
    dispose: () => view.dispose(),
  };
}
