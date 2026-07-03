// The framework-toggle seam. `mountViewer` mounts the framebuffer viewer under the chosen
// framework and returns a uniform handle (setFit / capture / dispose). Each path mounts the
// SAME core RemoteFramebufferView, minimally replicating what that framework's headless
// wrapper does — no wrapper-package build needed (mirrors reactViewer.ts). Every framework
// runtime is lazy-loaded (dynamic import) so the initial bundle only pays for the one picked.

import { RemoteFramebufferView, type RfbViewOptions } from "@habemus-papadum/rfb-widgets";
import type { FitMode, SurfacePreference, ViewPreset } from "@habemus-papadum/rfb-widgets";

export type Framework = "vanilla" | "react" | "svelte" | "solid";

export const FRAMEWORKS: { id: Framework; label: string }[] = [
  { id: "vanilla", label: "Vanilla" },
  { id: "react", label: "React" },
  { id: "svelte", label: "Svelte" },
  { id: "solid", label: "Solid" },
];

export interface ViewerHandle {
  framework: Framework;
  setFit(fit: FitMode, background?: string): void;
  /** Switch the display backend live (rebuilds the view + reconnects). */
  setSurface(kind: SurfacePreference): void;
  /** Multiply the current zoom (about the viewport center). */
  zoomBy(factor: number): void;
  /** Apply a named viewport preset (fit / cover / fill / one-to-one). */
  preset(p: ViewPreset): void;
  capture(): Promise<Blob>;
  // Client-side recording of what the viewer sees. `canRecord` is false on this Mode-A path
  // (the canvas is transferred to the decode worker) — see docs/guide_javascript.md (Recording).
  canRecord(): boolean;
  isRecording(): boolean;
  startRecording(): void;
  stopRecording(): Promise<Blob>;
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
      setSurface: (kind) => view?.setSurface(kind),
      zoomBy: (factor) => view?.zoomBy(factor),
      preset: (p) => view?.applyPreset(p),
      capture: async () => (await view!.capture("blob")) as Blob,
      canRecord: () => !!view?.canRecord,
      isRecording: () => !!view?.isRecording,
      startRecording: () => view?.startRecording(),
      stopRecording: () => view!.stopRecording(),
      dispose: () => root.unmount(),
    };
  }
  if (framework === "svelte") {
    const [{ mount, unmount }, { default: SvelteViewer }] = await Promise.all([
      import("svelte"),
      import("./SvelteViewer.svelte"),
    ]);
    let view: RemoteFramebufferView | null = null;
    const app = mount(SvelteViewer, {
      target: container,
      props: { options, onReady: (v: RemoteFramebufferView) => (view = v) },
    });
    return {
      framework,
      setFit: (fit, bg) => view?.setFit(fit, bg),
      setSurface: (kind) => view?.setSurface(kind),
      zoomBy: (factor) => view?.zoomBy(factor),
      preset: (p) => view?.applyPreset(p),
      capture: async () => (await view!.capture("blob")) as Blob,
      canRecord: () => !!view?.canRecord,
      isRecording: () => !!view?.isRecording,
      startRecording: () => view?.startRecording(),
      stopRecording: () => view!.stopRecording(),
      dispose: () => unmount(app),
    };
  }
  if (framework === "solid") {
    const { mountSolid } = await import("./solidViewer");
    const handle = mountSolid(container, options);
    return {
      framework,
      setFit: (fit, bg) => handle.view().setFit(fit, bg),
      setSurface: (kind) => handle.view().setSurface(kind),
      zoomBy: (factor) => handle.view().zoomBy(factor),
      preset: (p) => handle.view().applyPreset(p),
      capture: async () => (await handle.view().capture("blob")) as Blob,
      canRecord: () => handle.view().canRecord,
      isRecording: () => handle.view().isRecording,
      startRecording: () => handle.view().startRecording(),
      stopRecording: () => handle.view().stopRecording(),
      dispose: () => handle.dispose(),
    };
  }
  const view = new RemoteFramebufferView(container, options);
  return {
    framework,
    setFit: (fit, bg) => view.setFit(fit, bg),
    setSurface: (kind) => view.setSurface(kind),
    zoomBy: (factor) => view.zoomBy(factor),
    preset: (p) => view.applyPreset(p),
    capture: async () => (await view.capture("blob")) as Blob,
    canRecord: () => view.canRecord,
    isRecording: () => view.isRecording,
    startRecording: () => view.startRecording(),
    stopRecording: () => view.stopRecording(),
    dispose: () => view.dispose(),
  };
}
