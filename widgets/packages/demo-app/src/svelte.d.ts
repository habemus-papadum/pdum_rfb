// Let `tsc` accept `import Component from "./Foo.svelte"` (the Vite svelte plugin compiles
// the actual module at build time). Loose typing is fine for the demo's single component.
declare module "*.svelte" {
  import type { Component } from "svelte";

  const component: Component<Record<string, unknown>>;
  export default component;
}
