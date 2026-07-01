// The "React" framework path: a minimal React component that mounts the core
// RemoteFramebufferView into its own <div> (exactly what the @habemus-papadum/rfb-react
// headless hook does). Written with createElement (no JSX) so the demo build needs no
// JSX/plugin config — just the react + react-dom runtimes.

import { createElement, useEffect, useRef, type ReactElement } from "react";
import { RemoteFramebufferView, type RfbViewOptions } from "@habemus-papadum/rfb-widgets";

export interface ReactViewerProps {
  options: RfbViewOptions;
  onReady: (view: RemoteFramebufferView) => void;
}

export function ReactViewer({ options, onReady }: ReactViewerProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const view = new RemoteFramebufferView(ref.current, options);
    onReady(view);
    return () => view.dispose();
    // Mount once; the shell rebuilds the whole viewer when options change.
  }, []);
  return createElement("div", { ref, style: { width: "100%", height: "100%" } });
}
